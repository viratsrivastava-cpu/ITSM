const cds = require('@sap/cds');
const { resolveCurrentUserId } = require('./defaults');

// Business fields tracked in TicketHistory. Deliberately explicit rather
// than introspected from the CSN, so audit coverage is a conscious choice
// per field, not an accident of compiler internals.
const TRACKED_FIELDS = [
    'ticketType_ID', 'shortDescription', 'description',
    'reportedBy_ID', 'messageProcessor_ID', 'supportTeam_ID',
    'category1_ID', 'category2_ID', 'category3_ID', 'category4_ID', 'solutionCategory_ID',
    'status_ID', 'impact_ID', 'urgency_ID', 'priority_ID', 'recommendedPriority_ID',
    'language_ID', 'isStandard',
    'system_ID', 'softwareComponent_ID', 'softwareVersion', 'supportPackage', 'configurationItem_ID', 'relatedRFC',
    'firstResponseAt', 'dueAt', 'completedAt', 'irtStatus_ID', 'mptStatus_ID'
];

module.exports = function registerAudit(srv) {

    const { Tickets } = srv.entities;

    // Stash the pre-save state on the request so the after-handler can
    // diff against it. A brand-new ticket has no prior active row, so
    // `before` stays undefined and nothing is logged for its creation —
    // TicketHistory records changes, not the initial values.
    srv.before('SAVE', Tickets, async (req) => {
        if (!req.data.ID) return;
        req._before = await SELECT.one.from(Tickets).where({ ID: req.data.ID });
    });

    srv.after('SAVE', Tickets, async (data, req) => {
        const before = req._before;
        if (!before) return;

        const { TicketHistory } = cds.entities('ITSMService');
        const changedById = await resolveCurrentUserId(req);

        const rows = [];
        for (const field of TRACKED_FIELDS) {
            const oldValue = before[field];
            const newValue = data[field];
            if (String(oldValue ?? '') === String(newValue ?? '')) continue;

            rows.push({
                ticket_ID: data.ID,
                fieldName: field.replace(/_ID$/, ''),
                oldValue: oldValue == null ? null : String(oldValue),
                newValue: newValue == null ? null : String(newValue),
                changedBy_ID: changedById
            });
        }

        if (rows.length) await INSERT.into(TicketHistory).entries(rows);
    });

};
