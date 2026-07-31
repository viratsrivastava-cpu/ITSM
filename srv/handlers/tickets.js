/* =========================================================
   TICKET LIFECYCLE

   Everything a ticket does from creation to submission, driven
   entirely by CAP's standard CRUD events. No custom actions.

   Why these events:

     before READ    DRAFT tickets are private to their reporter.
                    `before` so the restriction narrows the query
                    CAP is about to run — filtering rows afterwards
                    would corrupt $count and paging.

     (CREATE is not handled here. Tickets are raised through the
     custom createTicket action, and its whole flow — validation,
     numbering, status, reporter, persistence — lives in
     handlers/create-ticket.js so it reads top to bottom in one
     place.)

     before UPDATE  Status transitions and who may make them.
                    `before` because an invalid transition has to be
                    refused while the request can still be rejected.
                    Validation in `after` would mean rolling back.

   History is written by srv/handlers/audit.js, which diffs every
   tracked field on UPDATE. Keeping it there — rather than adding a
   status-specific writer here — is what stops one status change
   producing two TicketHistory rows.

   Since the Ticket/IncidentForm split:
     - the key is `ticketID` (String(30)), not a UUID `ID`;
     - status/priority/ticketType/reportedBy are plain codes on the
       ticket rather than associations, so no LookupValue join is
       needed to read or compare them;
     - the incident-specific fields live on IncidentForm and arrive
       as a nested `incidentForm` object on a deep insert.
   ========================================================= */

const cds = require('@sap/cds');
// The numbering rules live with the create flow; the preview below
// reuses them rather than keeping a second copy.
const { PREFIX_BY_TICKET_TYPE, DEFAULT_PREFIX, formatTicketNumber } = require('./create-ticket');

const STATUS_DRAFT = 'DRAFT';

// Which status a ticket may move to, from where. Anything not listed
// is refused by validateTicketUpdate.
const ALLOWED_TRANSITIONS = {
    DRAFT: ['SUBMITTED'],
    SUBMITTED: ['NEW', 'IN_PROCESS'],
    NEW: ['IN_PROCESS', 'CUSTOMER_ACTION'],
    IN_PROCESS: ['CUSTOMER_ACTION', 'SOLUTION_PROPOSED', 'CONFIRMED', 'CLOSED'],
    CUSTOMER_ACTION: ['IN_PROCESS', 'SOLUTION_PROPOSED', 'CLOSED'],
    SOLUTION_PROPOSED: ['CONFIRMED', 'IN_PROCESS', 'CLOSED'],
    CONFIRMED: ['CLOSED'],
    CLOSED: []
};

// Transitions only the ticket's own reporter may make. Submitting is
// the reporter's act: the DRAFT was private to them, so nobody else
// gets to push it into the queue.
const REPORTER_ONLY_TRANSITIONS = { SUBMITTED: true };


module.exports = function () {

    this.before('READ', 'Tickets', restrictDraftTicketVisibility);
    this.before('UPDATE', 'Tickets', validateTicketUpdate);

    this.on('nextTicketNumber', previewNextTicketNumber);
};


/* =========================================================
   Implementations
   ========================================================= */


/**
 * A ticket saved but not yet submitted is the reporter's own work in
 * progress; everyone else sees it only from SUBMITTED onwards.
 *
 * A before-READ filter rather than a `where` on the projection, because
 * the rule depends on who is asking — something a static `where` cannot
 * express.
 */
function restrictDraftTicketVisibility(req) {
    const me = currentUserId(req);

    if (me) {
        req.query.where(
            `(status != ${sqlString(STATUS_DRAFT)} or status is null)`
            + ` or reportedBy = ${sqlString(me)}`
        );
    } else {
        // Not a known signed-in user: there is no "mine" to widen with.
        req.query.where(`status != ${sqlString(STATUS_DRAFT)} or status is null`);
    }
}


/**
 * Refuse illegal status moves, and enforce who may make them.
 *
 * Submit is a plain UPDATE of `status`, so it lands here like any other
 * edit — no separate action, and no second code path to keep in step.
 */
async function validateTicketUpdate(req) {
    if (req.data.status === undefined) return;      // status not being changed

    const ticketID = ticketIdOf(req);
    if (!ticketID) return;

    const before = await SELECT.one.from(cds.entities('ITSMService').Tickets)
        .columns('status', 'reportedBy')
        .where({ ticketID });
    if (!before) return;                            // CAP's own handler will 404

    const fromCode = before.status;
    const toCode = req.data.status;
    if (toCode === fromCode) return;

    if (!(toCode in ALLOWED_TRANSITIONS)) {
        return req.reject(400, `Unknown target status "${toCode}".`);
    }

    const allowed = ALLOWED_TRANSITIONS[fromCode];
    if (!allowed || allowed.indexOf(toCode) === -1) {
        return req.reject(400, `A ticket cannot move from ${fromCode || 'unset'} to ${toCode}.`);
    }

    if (REPORTER_ONLY_TRANSITIONS[toCode]) {
        const me = currentUserId(req);
        if (!me || before.reportedBy !== me) {
            return req.reject(403, 'Only the reporter of a ticket can submit it.');
        }
    }
}


/**
 * What the counter would hand out next, for the create form to show
 * before the ticket exists.
 *
 * Deliberately does NOT consume a number — an abandoned form must not
 * burn one — so the value is a best guess that a concurrent create may
 * take first. The authoritative number is reserved during createTicket.
 *
 * Stays a function rather than becoming a CRUD event because it reads
 * something that does not exist yet: there is no entity to GET.
 */
async function previewNextTicketNumber(req) {
    const prefix = PREFIX_BY_TICKET_TYPE[req.data.ticketTypeCode] || DEFAULT_PREFIX;
    const { TicketCounter } = cds.entities('itsm.master');
    const row = await SELECT.one.from(TicketCounter).columns('lastNumber').where({ prefix });
    return formatTicketNumber(prefix, (row ? row.lastNumber : 0) + 1);
}


/* =========================================================
   Helpers
   ========================================================= */

// On a PATCH the key is in the request path, not the payload.
function ticketIdOf(req) {
    if (req.data && req.data.ticketID) return req.data.ticketID;
    const params = req.params && req.params[req.params.length - 1];
    if (!params) return null;
    return typeof params === 'object' ? params.ticketID : params;
}


// reportedBy is a User.userId string since the entity split, which is
// exactly what the authenticated identity already is.
function currentUserId(req) {
    const id = req.user && req.user.id;
    return (!id || id === 'anonymous') ? null : id;
}



// req.query.where(<string>) does not bind parameters, so fragments are
// built here. The values are UUIDs from the database and the session,
// never request payload — quoted defensively regardless.
function sqlString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}
