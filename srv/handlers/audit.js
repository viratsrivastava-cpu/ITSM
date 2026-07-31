/* =========================================================
   TICKET CHANGE HISTORY

   The single place TicketHistory rows are written. Every other
   handler stays out of it, which is what guarantees one row per
   changed field rather than duplicates from competing writers.

   Why these events:

     before UPDATE  Reads the row as it is now and stashes it on the
                    request. It has to be `before`, because once the
                    UPDATE has run the old values are gone.

     after UPDATE   Diffs the stashed row against what was actually
                    sent and inserts the history rows. `after`, so
                    nothing is logged for an update that failed
                    validation or was rejected downstream.

   No CREATE hook on purpose: TicketHistory records *changes*, and a
   brand-new ticket has no previous values to change from. Its
   initial state is the ticket row itself.
   ========================================================= */

const cds = require('@sap/cds');
const { resolveCurrentUserId } = require('./defaults');

// Business fields tracked in TicketHistory. Deliberately explicit
// rather than introspected from the CSN, so audit coverage is a
// conscious choice per field, not an accident of compiler internals.
const TRACKED_FIELDS = [
    'ticketType_ID', 'shortDescription', 'description',
    'reportedBy_ID', 'messageProcessor_ID', 'supportTeam_ID',
    'category1_ID', 'category2_ID', 'category3_ID', 'category4_ID', 'solutionCategory_ID',
    'status_ID', 'impact_ID', 'urgency_ID', 'priority_ID', 'recommendedPriority_ID',
    'language_ID', 'isStandard',
    'system_ID', 'softwareComponent_ID', 'softwareVersion', 'supportPackage',
    'configurationItem_ID', 'relatedRFC',
    'firstResponseAt', 'dueAt', 'completedAt', 'irtStatus_ID', 'mptStatus_ID'
];


module.exports = function registerAudit(srv) {

    const { Tickets } = srv.entities;

    srv.before('UPDATE', Tickets, stashPreviousValues);
    srv.after('UPDATE', Tickets, writeChangedFields);
};


async function stashPreviousValues(req) {
    const ID = ticketIdOf(req);
    if (!ID) return;

    const { Tickets } = cds.entities('ITSMService');
    req._before = await SELECT.one.from(Tickets).where({ ID });
}


async function writeChangedFields(_data, req) {
    const before = req._before;
    if (!before) return;

    const rows = [];
    for (const field of TRACKED_FIELDS) {
        // Only fields the request actually sent can have changed.
        if (!(field in req.data)) continue;

        const oldValue = before[field];
        const newValue = req.data[field];
        if (String(oldValue ?? '') === String(newValue ?? '')) continue;

        rows.push({
            ticket_ID: before.ID,
            fieldName: field.replace(/_ID$/, ''),
            oldValue: oldValue == null ? null : String(oldValue),
            newValue: newValue == null ? null : String(newValue),
            changedBy_ID: await resolveCurrentUserId(req)
        });
    }

    if (rows.length) await INSERT.into(cds.entities('ITSMService').TicketHistory).entries(rows);
}


// On a PATCH the key is in the request path, not the payload.
function ticketIdOf(req) {
    if (req.data && req.data.ID) return req.data.ID;
    const params = req.params && req.params[req.params.length - 1];
    if (!params) return null;
    return typeof params === 'object' ? params.ID : params;
}
