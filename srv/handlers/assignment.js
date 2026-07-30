const cds = require('@sap/cds');
const { resolveCurrentUserId } = require('./defaults');

// Fields this action is allowed to touch, and the TicketHistory field name
// each one is logged under. Kept aligned with TRACKED_FIELDS in audit.js so
// an assignment made here reads identically in the change history to one
// made by editing the ticket.
const ASSIGNABLE = {
    messageProcessor: 'messageProcessor',
    supportTeam: 'supportTeam'
};

module.exports = function registerAssignment(srv) {

    srv.on('assignTickets', onAssignTickets);

    // Who am I. The role flags come from the authenticated identity
    // (mocked users locally, XSUAA scopes on CF); the name/email come from
    // the matching master.User row when there is one. A signed-in identity
    // with no master.User row is legitimate — it just has no personal
    // ticket queue, so ID stays null and the UI says so.
    srv.on('currentUser', async (req) => {
        const ID = await resolveCurrentUserId(req);
        const profile = ID
            ? await SELECT.one.from(cds.entities('ITSMService').Users).where({ ID })
            : null;

        return {
            ID: ID || null,
            userId: (req.user && req.user.id) || null,
            name: (profile && profile.name) || (req.user && req.user.id) || 'Unknown user',
            email: (profile && profile.email) || null,
            isServiceGroup: req.user.is('ServiceGroup'),
            isAdmin: req.user.is('Admin')
        };
    });

};


async function onAssignTickets(req) {
    const { tickets, messageProcessor, supportTeam } = req.data;

    if (!Array.isArray(tickets) || tickets.length === 0) {
        return req.reject(400, 'Select at least one ticket to assign.');
    }
    if (messageProcessor == null && supportTeam == null) {
        return req.reject(400, 'Choose an engineer, an assignment group, or both.');
    }

    // Association targets are not FK-checked on this path, so verify them
    // here — otherwise a hand-rolled request could park every ticket on an
    // engineer or group that does not exist, and nothing would complain
    // until someone tried to read the assignment back.
    const { User, SupportTeam } = cds.entities('itsm.master');
    if (messageProcessor != null) {
        const found = await SELECT.one.from(User).columns('ID').where({ ID: messageProcessor });
        if (!found) return req.reject(400, `No such engineer: ${messageProcessor}`);
    }
    if (supportTeam != null) {
        const found = await SELECT.one.from(SupportTeam).columns('ID').where({ ID: supportTeam });
        if (!found) return req.reject(400, `No such assignment group: ${supportTeam}`);
    }

    // Straight at the persistence entity, not the service projection: the
    // projection is draft-enabled, and this action's whole point is to skip
    // the draft round-trip (see the comment on the action in service.cds).
    const { Ticket, TicketHistory } = cds.entities('itsm.txn');

    const before = await SELECT.from(Ticket)
        .columns('ID', 'messageProcessor_ID', 'supportTeam_ID')
        .where({ ID: { in: tickets } });

    if (before.length === 0) return 0;

    const next = {};
    if (messageProcessor != null) next.messageProcessor_ID = messageProcessor;
    if (supportTeam != null) next.supportTeam_ID = supportTeam;

    // Only tickets whose values actually differ — so a bulk assign that
    // re-picks the engineer some rows already have doesn't fill the audit
    // trail with no-op entries, and the returned count stays truthful.
    const changed = before.filter((row) =>
        Object.keys(next).some((field) => String(row[field] ?? '') !== String(next[field] ?? ''))
    );

    if (changed.length === 0) return 0;

    const changedIds = changed.map((row) => row.ID);
    await UPDATE(Ticket).set(next).where({ ID: { in: changedIds } });

    const changedById = await resolveCurrentUserId(req);
    const rows = [];
    for (const row of changed) {
        for (const [field, historyName] of Object.entries(ASSIGNABLE)) {
            const key = `${field}_ID`;
            if (!(key in next)) continue;
            if (String(row[key] ?? '') === String(next[key] ?? '')) continue;
            rows.push({
                ticket_ID: row.ID,
                fieldName: historyName,
                oldValue: row[key] == null ? null : String(row[key]),
                newValue: next[key] == null ? null : String(next[key]),
                changedBy_ID: changedById
            });
        }
    }
    if (rows.length) await INSERT.into(TicketHistory).entries(rows);

    return changed.length;
}
