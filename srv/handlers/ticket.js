const cds = require('@sap/cds');
const { generateTicketNumber } = require('../utils/ticket-number');
const { currentUserId, resolveUserKey, keyOf } = require('../utils/user');
const { captureAggregate, logAggregateChanges, logField } = require('../utils/history');

const STATUS_DRAFT = 'DRAFT';
const STATUS_OPEN = 'OPEN';

const SYSTEM_FIELDS = [
    'ticketID', 'ticketNumber', 'status', 'reportedBy',
    'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
];


async function beforeCreateTicket(req) {

    const data = req.data;

    data.ticketNumber = await generateTicketNumber(data.ticketType);
    data.ticketID = data.ticketNumber;

    data.status = STATUS_DRAFT;
    data.reportedBy = currentUserId(req);

    if (Array.isArray(data.comments) && data.comments.length) {       // optional as we havent made comment section right now
        const authorKey = await resolveUserKey(req);
        for (const comment of data.comments) {
            if (!comment.author_ID) comment.author_ID = authorKey;
        }
    }
}


async function onUpdateTicket(req, next) {

    const data = req.data;
    const ticketID = keyOf(req, 'ticketID');

    for (const field of SYSTEM_FIELDS) delete data[field];

    if (data.incidentForm && ticketID) {
        const existing = await SELECT.one.from(cds.entities('ITSMService').IncidentForms)
            .columns('ID').where({ ticket_ticketID: ticketID });

        if (existing) data.incidentForm.ID = existing.ID;
    }

    if (Array.isArray(data.comments) && data.comments.length) {
        const authorKey = await resolveUserKey(req);
        for (const comment of data.comments) {
            if (!comment.author_ID) comment.author_ID = authorKey;
        }
    }

    await captureAggregate(req);

    const result = await next();

    await logAggregateChanges(req);

    return result;
}


async function onReadTicket(req, next) {

    const me = currentUserId(req);

    if (req.user.is('Admin')) {

    } else if (!me) {
        req.query.where('1 = 0');

    } else if (req.user.is('ServiceGroup')) {
        req.query.where(
            `(status != ${sql(STATUS_DRAFT)} or status is null)`
            + ` or reportedBy = ${sql(me)}`
        );

    } else {
        req.query.where(`reportedBy = ${sql(me)}`);
    }

    return next();
}


async function onSubmitTicket(req) {

    const ticketID = keyOf(req, 'ticketID');
    if (!ticketID) return req.reject(400, 'No ticket to submit.');

    const { Tickets } = cds.entities('ITSMService');
    const ticket = await SELECT.one.from(Tickets)
        .columns('ticketID', 'status', 'reportedBy')
        .where({ ticketID });

    if (!ticket) return req.reject(404, `Ticket ${ticketID} not found.`);

    if (ticket.status !== STATUS_DRAFT) {
        return req.reject(400,
            `Only a draft can be submitted (this ticket is ${ticket.status || 'unset'}).`);
    }

    if (ticket.reportedBy !== currentUserId(req)) {
        return req.reject(403, 'Only the reporter of a ticket can submit it.');
    }

    await UPDATE(cds.entities('itsm.txn').Ticket)
        .set({ status: STATUS_OPEN })
        .where({ ticketID });

    await logField(req, ticketID, 'status', STATUS_DRAFT, STATUS_OPEN);

    return SELECT.one.from(Tickets).where({ ticketID });
}


function sql(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}


module.exports = { beforeCreateTicket, onUpdateTicket, onReadTicket, onSubmitTicket };
