const cds = require('@sap/cds');
const { currentUserId, keyOf } = require('./user');

const TICKET_FIELDS = [
    'ticketType', 'shortDescription', 'status', 'priority',
    'reportedBy', 'messageProcessor', 'supportTeam',
    'firstResponseAt', 'dueAt', 'completedAt'
];

const FORM_FIELDS = [
    'description', 'category1', 'category2', 'category3', 'category4',
    'solutionCategory', 'impact', 'urgency', 'recommendedPriority',
    'language', 'isStandard', 'system', 'softwareComponent',
    'softwareVersion', 'supportPackage', 'configurationItem',
    'relatedRFC', 'irtStatus', 'mptStatus'
];


async function captureAggregate(req) {
    const ticketID = keyOf(req, 'ticketID');
    if (!ticketID) return;

    const { Tickets, IncidentForms } = cds.entities('ITSMService');

    req._before = await SELECT.one.from(Tickets).where({ ticketID });

    if (req.data.incidentForm) {
        req._beforeForm = await SELECT.one.from(IncidentForms)
            .where({ ticket_ticketID: ticketID });
    }
}


async function logAggregateChanges(req) {
    const before = req._before;
    if (!before) return;

    const ticketID = before.ticketID;

    await logChanges(req, before, req.data, TICKET_FIELDS, ticketID);

    if (req._beforeForm && req.data.incidentForm) {
        await logChanges(req, req._beforeForm, req.data.incidentForm,
            FORM_FIELDS, ticketID);
    }
}


async function logField(req, ticketID, fieldName, oldValue, newValue) {
    if (!ticketID) return;
    await insert([row(ticketID, fieldName, oldValue, newValue, currentUserId(req))]);
}


async function logChanges(req, before, sent, fields, ticketID) {
    if (!ticketID || !before) return;

    const changedBy = currentUserId(req);
    const rows = [];

    for (const field of fields) {
        if (!(field in sent)) continue;

        const oldValue = before[field];
        const newValue = sent[field];
        if (same(oldValue, newValue)) continue;

        rows.push(row(ticketID, field, oldValue, newValue, changedBy));
    }

    await insert(rows);
}

function row(ticketID, fieldName, oldValue, newValue, changedBy) {
    return {
        ticket_ticketID: ticketID,
        fieldName,
        oldValue: oldValue == null ? null : String(oldValue),
        newValue: newValue == null ? null : String(newValue),
        changedBy
    };
}

function same(a, b) { return String(a ?? '') === String(b ?? ''); }

async function insert(rows) {
    if (!rows.length) return;
    await INSERT.into(cds.entities('ITSMService').TicketHistory).entries(rows);
}


module.exports = { captureAggregate, logAggregateChanges, logField };
