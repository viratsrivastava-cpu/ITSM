/* =========================================================
   TICKET LIFECYCLE

   Everything a ticket does from creation to submission, driven
   entirely by CAP's standard CRUD events. No custom actions.

   Why these events:

     before READ    DRAFT tickets are private to their reporter.
                    `before` so the restriction narrows the query
                    CAP is about to run — filtering rows afterwards
                    would corrupt $count and paging.

     before CREATE  A ticket is numbered, put into DRAFT status and
                    given a reporter at the moment it is created.
                    `before` because all three must be in the row
                    that gets inserted; `after` would need a second
                    UPDATE, and `on` would mean re-implementing the
                    insert CAP already does correctly.

     before UPDATE  Status transitions and who may make them.
                    `before` because an invalid transition has to be
                    refused while the request can still be rejected.
                    Validation in `after` would mean rolling back.

   History is written by srv/handlers/audit.js, which diffs every
   tracked field on UPDATE. Keeping it there — rather than adding a
   status-specific writer here — is what stops one status change
   producing two TicketHistory rows.
   ========================================================= */

const cds = require('@sap/cds');
const { resolveCurrentUserId } = require('./defaults');

const PREFIX_BY_TICKET_TYPE = {
    INCIDENT: 'INC',
    SERVICE_REQUEST: 'SRV',
    PROBLEM: 'PRB',
    CHANGE: 'CHG'
};
const DEFAULT_PREFIX = 'INC';
const NUMBER_DIGITS = 7;

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
    this.before('CREATE', 'Tickets', prepareNewTicket);
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
 * A before-READ filter rather than a `where` on the projection,
 * because the rule needs the master.User row matching the request
 * user — a lookup, not something a static `where` can express.
 */
async function restrictDraftTicketVisibility(req) {
    const draftStatusId = await statusIdByCode(STATUS_DRAFT);
    if (!draftStatusId) return;          // no DRAFT status configured

    const meId = await resolveCurrentUserId(req);

    if (meId) {
        req.query.where(
            `(status_ID != ${sqlString(draftStatusId)} or status_ID is null)`
            + ` or reportedBy_ID = ${sqlString(meId)}`
        );
    } else {
        // Signed in but with no matching master.User row: there is no
        // "mine" to widen the rule with.
        req.query.where(`status_ID != ${sqlString(draftStatusId)} or status_ID is null`);
    }
}


/**
 * Number the ticket, put it in DRAFT and make sure it has a reporter.
 *
 * Status is forced rather than defaulted: the create form pre-selects
 * the STATUS marked isDefault (New), so "only fill it if empty" would
 * let a brand new ticket skip DRAFT entirely and never offer Submit.
 */
async function prepareNewTicket(req) {
    if (!req.data.ticketNumber) {
        req.data.ticketNumber = await nextTicketNumberFor(req.data.ticketType_ID);
    }

    const draftStatusId = await statusIdByCode(STATUS_DRAFT);
    if (draftStatusId) req.data.status_ID = draftStatusId;

    // The DRAFT visibility rule keys off reportedBy, so a ticket stored
    // without one would be invisible to everybody — including the person
    // who just created it.
    if (!req.data.reportedBy_ID) {
        req.data.reportedBy_ID = await resolveCurrentUserId(req);
    }
}


/**
 * Refuse illegal status moves, and enforce who may make them.
 *
 * Submit is a plain UPDATE of `status`, so it lands here like any other
 * edit — no separate action, no separate code path to keep in step.
 */
async function validateTicketUpdate(req) {
    if (req.data.status_ID === undefined) return;   // status not being changed

    const ID = ticketIdOf(req);
    if (!ID) return;

    const before = await SELECT.one.from(cds.entities('ITSMService').Tickets)
        .columns('status_ID', 'reportedBy_ID')
        .where({ ID });
    if (!before) return;                            // CAP's own handler will 404

    if (req.data.status_ID === before.status_ID) return;

    const fromCode = await statusCodeById(before.status_ID);
    const toCode = await statusCodeById(req.data.status_ID);

    if (!toCode) return req.reject(400, 'Unknown target status.');

    const allowed = ALLOWED_TRANSITIONS[fromCode];
    if (!allowed || allowed.indexOf(toCode) === -1) {
        return req.reject(400, `A ticket cannot move from ${fromCode || 'unset'} to ${toCode}.`);
    }

    if (REPORTER_ONLY_TRANSITIONS[toCode]) {
        const meId = await resolveCurrentUserId(req);
        if (!meId || before.reportedBy_ID !== meId) {
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
 * take first. The authoritative number is reserved in before CREATE.
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
    if (req.data && req.data.ID) return req.data.ID;
    const params = req.params && req.params[req.params.length - 1];
    if (!params) return null;
    return typeof params === 'object' ? params.ID : params;
}


async function statusIdByCode(code) {
    const { LookupValue } = cds.entities('itsm.master');
    const row = await SELECT.one.from(LookupValue).columns('ID')
        .where({ lookupType: 'STATUS', code });
    return row ? row.ID : null;
}


async function statusCodeById(id) {
    if (!id) return null;
    const { LookupValue } = cds.entities('itsm.master');
    const row = await SELECT.one.from(LookupValue).columns('code')
        .where({ ID: id, lookupType: 'STATUS' });
    return row ? row.code : null;
}


async function prefixForTicketType(ticketTypeId) {
    if (!ticketTypeId) return DEFAULT_PREFIX;
    const { LookupValue } = cds.entities('itsm.master');
    const row = await SELECT.one.from(LookupValue).columns('code')
        .where({ ID: ticketTypeId, lookupType: 'TICKET_TYPE' });
    return (row && PREFIX_BY_TICKET_TYPE[row.code]) || DEFAULT_PREFIX;
}


/**
 * Reserve the next number for a prefix, atomically.
 *
 * `UPDATE ... SET lastNumber = lastNumber + 1` is evaluated by the
 * database, not read-modify-written in Node, so two concurrent creates
 * cannot compute the same value from a stale read. That statement
 * write-locks the row for the rest of the transaction, so the SELECT
 * after it sees this transaction's own value and a competing create
 * blocks until we commit.
 *
 * Doing it the obvious way instead — SELECT lastNumber, then UPDATE to
 * lastNumber + 1 — is exactly the race this avoids.
 */
async function reserveNextNumber(prefix) {
    const { TicketCounter } = cds.entities('itsm.master');

    const updated = await UPDATE(TicketCounter)
        .set({ lastNumber: { '+=': 1 } })
        .where({ prefix });

    // No counter row for this prefix yet (a prefix added after the seed
    // data was loaded). Create it, then take its first number.
    if (!updated) {
        await INSERT.into(TicketCounter).entries({ prefix, lastNumber: 1 });
        return 1;
    }

    const row = await SELECT.one.from(TicketCounter).columns('lastNumber').where({ prefix });
    return row.lastNumber;
}


function formatTicketNumber(prefix, number) {
    return `${prefix}-${String(number).padStart(NUMBER_DIGITS, '0')}`;
}


async function nextTicketNumberFor(ticketTypeId) {
    const prefix = await prefixForTicketType(ticketTypeId);
    return formatTicketNumber(prefix, await reserveNextNumber(prefix));
}


// req.query.where(<string>) does not bind parameters, so fragments are
// built here. The values are UUIDs from the database and the session,
// never request payload — quoted defensively regardless.
function sqlString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}
