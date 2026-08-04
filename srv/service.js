const cds = require('@sap/cds');

const { beforeCreateTicket, onUpdateTicket, onReadTicket, onSubmitTicket } = require('./handlers/ticket');
const { onCurrentUser, onAssignTickets } = require('./handlers/dashboard');

/* =========================================================
   ITSM SERVICE — AGGREGATE ROOT ARCHITECTURE

   Ticket is the root. Every other business entity is a
   composition child of it and is written as part of its ticket,
   so Ticket is the only entity with lifecycle hooks:

       Ticket                      <- hooks live here
         ├── incidentForm
         │     ├── sapNotes
         │     └── sapNoteSearch
         ├── comments
         ├── attachments
         ├── scheduledActions
         ├── transactions
         └── history

   Six registrations: three CRUD hooks on Tickets, plus one per
   custom operation.

     CREATE        generate IDs + enrich the whole aggregate
     UPDATE        deep update, ticket + children, one flow
     READ          role-based visibility (own / queue / all)
     submitTicket  the only DRAFT -> OPEN door
     currentUser   the caller's identity and role flags
     assignTickets service-group bulk (re)assignment

   No child entity has a hook. That is not a stylistic choice: a
   nested composition raises NO CREATE or UPDATE event of its
   own — CAP writes child rows as part of the parent's statement
   — so a hook on TicketComments would never fire for a comment
   that arrived inside a ticket payload. Child enrichment happens
   inline in the ticket handlers instead.

   No business logic belongs in this file.
   ========================================================= */

module.exports = cds.service.impl(async function () {

    const { Tickets } = this.entities;


    this.before('CREATE', Tickets, beforeCreateTicket);
    this.on('UPDATE', Tickets, onUpdateTicket);
    this.on('READ', Tickets, onReadTicket);

    this.on('submitTicket', onSubmitTicket);
    this.on('currentUser', onCurrentUser);
    this.on('assignTickets', onAssignTickets);


    /* ---------------------------------------------------------
       DELETE — no hook. Deleting a ticket cascades to every
       composed child through the compositions in the data model,
       which is exactly the aggregate-root semantics we want.
       --------------------------------------------------------- */
});
