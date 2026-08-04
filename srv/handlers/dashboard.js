const cds = require('@sap/cds');
const { currentUserId, resolveUserKey } = require('../utils/user');
const { logField } = require('../utils/history');

const ASSIGNABLE = {
    messageProcessor: 'messageProcessor',
    supportTeam: 'supportTeam'
};


async function onCurrentUser(req) {
    const ID = await resolveUserKey(req);
    const profile = ID
        ? await SELECT.one.from(cds.entities('ITSMService').Users).where({ ID })
        : null;

    return {
        ID: ID || null,
        userId: currentUserId(req),
        name: (profile && profile.name) || currentUserId(req) || 'Unknown user',
        email: (profile && profile.email) || null,
        isServiceGroup: req.user.is('ServiceGroup'),
        isAdmin: req.user.is('Admin')
    };
}


async function onAssignTickets(req) {
    const { tickets, messageProcessor, supportTeam } = req.data;

    if (!Array.isArray(tickets) || tickets.length === 0) {
        return req.reject(400, 'Select at least one ticket to assign.');
    }
    if (messageProcessor == null && supportTeam == null) {
        return req.reject(400, 'Choose an engineer, an assignment group, or both.');
    }

    const { User, SupportTeam, Ticket } = {
        ...cds.entities('itsm.master'), ...cds.entities('itsm.txn')
    };

    if (messageProcessor != null) {
        const found = await SELECT.one.from(User).columns('userId').where({ userId: messageProcessor });
        if (!found) return req.reject(400, `No such engineer: ${messageProcessor}`);
    }
    if (supportTeam != null) {
        const found = await SELECT.one.from(SupportTeam).columns('teamCode').where({ teamCode: supportTeam });
        if (!found) return req.reject(400, `No such assignment group: ${supportTeam}`);
    }

    const before = await SELECT.from(Ticket)
        .columns('ticketID', 'messageProcessor', 'supportTeam')
        .where({ ticketID: { in: tickets } });
    if (before.length === 0) return 0;

    const next = {};
    if (messageProcessor != null) next.messageProcessor = messageProcessor;
    if (supportTeam != null) next.supportTeam = supportTeam;

    const changed = before.filter(row =>
        Object.keys(next).some(f => String(row[f] ?? '') !== String(next[f] ?? ''))
    );
    if (changed.length === 0) return 0;

    await UPDATE(Ticket).set(next).where({ ticketID: { in: changed.map(r => r.ticketID) } });

    for (const row of changed) {
        for (const [field, fieldName] of Object.entries(ASSIGNABLE)) {
            if (!(field in next)) continue;
            if (String(row[field] ?? '') === String(next[field] ?? '')) continue;
            await logField(req, row.ticketID, fieldName, row[field], next[field]);
        }
    }

    return changed.length;
}

module.exports = { onCurrentUser, onAssignTickets };
