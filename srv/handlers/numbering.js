const cds = require('@sap/cds');

const {
    DEFAULT_PREFIX,
    PREFIX_BY_TICKET_TYPE,
    formatTicketNumber
} = require('./ticket-actions');

/* =========================================================
   Read-only preview of the next ticket number, for the create
   form to show before the ticket is actually saved.

   Deliberately does NOT consume a number: it reports what the
   counter would hand out next, and an abandoned form must not
   burn a number. The authoritative number is reserved during
   SAVE (see ticket-actions.js), so the value shown here is a
   best guess that another concurrent save may take first.
   ========================================================= */

module.exports = function registerNumbering(srv) {
    srv.on('nextTicketNumber', onNextTicketNumber);
};


async function onNextTicketNumber(req) {
    const { ticketTypeCode } = req.data;
    const prefix = PREFIX_BY_TICKET_TYPE[ticketTypeCode] || DEFAULT_PREFIX;

    const { TicketCounter } = cds.entities('itsm.master');
    const row = await SELECT.one.from(TicketCounter).columns('lastNumber').where({ prefix });

    return formatTicketNumber(prefix, (row ? row.lastNumber : 0) + 1);
}
