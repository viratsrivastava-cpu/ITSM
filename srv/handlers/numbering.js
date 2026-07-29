const cds = require('@sap/cds');

const TICKET_NUMBER_PREFIX = 'TKT-';
const TICKET_NUMBER_SEED = 100000;

module.exports = function registerNumbering(srv) {

    const { Tickets } = srv.entities;

    srv.on('nextTicketNumber', onNextTicketNumber);

    // Assigned on SAVE (draft activation), not on draft creation, so an
    // abandoned/cancelled draft never burns a ticket number.
    srv.before('SAVE', Tickets, beforeSaveAssignNumber);

};


async function onNextTicketNumber() {
    const { Tickets } = cds.entities('ITSMService');
    return computeNextTicketNumber(Tickets);
}


async function beforeSaveAssignNumber(req) {
    if (req.data.ticketNumber) return;
    const { Tickets } = cds.entities('ITSMService');
    req.data.ticketNumber = await computeNextTicketNumber(Tickets);
}


async function computeNextTicketNumber(Tickets) {
    const rows = await SELECT.from(Tickets).columns('ticketNumber');

    let max = TICKET_NUMBER_SEED;
    for (const row of rows) {
        const match = /^TKT-(\d+)$/.exec(row.ticketNumber || '');
        if (match) max = Math.max(max, Number(match[1]));
    }

    return TICKET_NUMBER_PREFIX + String(max + 1).padStart(6, '0');
}
