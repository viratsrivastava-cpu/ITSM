const cds = require('@sap/cds');

const registerTickets = require('./handlers/tickets');
const registerCategories = require('./handlers/categories');
const registerAudit = require('./handlers/audit');
const registerAssignment = require('./handlers/assignment');
const registerCreateTicket = require('./handlers/create-ticket');
const { registerDefaults } = require('./handlers/defaults');

module.exports = cds.service.impl(async function () {

    // Ticket lifecycle: visibility, validation, numbering and the
    // DRAFT/SUBMITTED flow — all on CAP's own CRUD events.
    registerTickets.call(this);

    // Cross-cutting concerns, each owning its own events.
    registerCategories(this);   // category tree helpers
    registerAudit(this);        // generic TicketHistory diff on SAVE
    registerAssignment(this);   // bulk (re)assignment + currentUser
    registerCreateTicket(this); // the custom Create API
    registerDefaults(this);     // comment author default
});
