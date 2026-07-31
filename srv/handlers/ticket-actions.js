const cds = require('@sap/cds');
const { resolveCurrentUserId } = require('./defaults');

/* =========================================================
   TWO-PHASE TICKET CREATE

     saveTicket   — on the DRAFT: assign a ticketNumber for the
                    chosen ticketType, set status DRAFT, activate.
     submitTicket — on the ACTIVE row, only while status is DRAFT:
                    move to SUBMITTED and log the change.

   Numbering deliberately lives in the before-SAVE hook rather
   than inside saveTicket. SAVE fires on draft activation however
   activation was triggered — the custom action, the standard
   draftActivate, or a Fiori Elements Save — so a ticket can never
   reach the active table without a number. saveTicket is then a
   thin wrapper that activates and returns the row.
   ========================================================= */

const PREFIX_BY_TICKET_TYPE = {
    INCIDENT: 'INC',
    SERVICE_REQUEST: 'SRV',
    PROBLEM: 'PRB',
    CHANGE: 'CHG'
};
const DEFAULT_PREFIX = 'INC';
const NUMBER_DIGITS = 7;

const STATUS_DRAFT = 'DRAFT';
const STATUS_SUBMITTED = 'SUBMITTED';


module.exports = function registerTicketActions(srv) {

    const { Tickets } = srv.entities;

    // saveTicket is invoked on the DRAFT instance, which CAP dispatches
    // against the separate `.drafts` target — registering only on Tickets
    // gives "no handler for saveTicket ITSMService.Tickets.drafts". It is
    // registered on both so calling it on an already-active ticket gives a
    // clean 404 from the handler rather than a routing error.
    // srv is passed through explicitly rather than read off `this`: these are
    // standalone module functions, and saveTicket needs the service to
    // trigger draft activation.
    const save = (req) => onSaveTicket(req, srv);
    srv.on('saveTicket', Tickets, save);
    if (Tickets.drafts) srv.on('saveTicket', Tickets.drafts, save);

    srv.on('submitTicket', Tickets, onSubmitTicket);

    // Submitting straight from an unsaved draft is a real mistake a user can
    // make (press Submit before Save). Without this it surfaces as a raw
    // "no handler for submitTicket ITSMService.Tickets.drafts" 501.
    if (Tickets.drafts) {
        srv.on('submitTicket', Tickets.drafts, (req) =>
            req.reject(400, 'Save this ticket before submitting it.'));
    }

    // Every path into the active table goes through SAVE, so this is the
    // one place that has to get numbering and the initial status right.
    srv.before('SAVE', Tickets, beforeSaveStampNumberAndStatus);
};


/* ---------------------------------------------------------
 * SAVE (phase 1)
 * ------------------------------------------------------- */
async function onSaveTicket(req, srv) {
    const { ID } = req.params[req.params.length - 1];

    const draft = await SELECT.one
        .from(cds.entities('ITSMService').Tickets.drafts)
        .columns('ID')
        .where({ ID });

    if (!draft) {
        return req.reject(404, 'This ticket has no draft to save. It may already have been saved.');
    }

    // Delegate to CAP's own draft activation rather than copying the draft
    // across by hand: it is what runs the SAVE handlers (numbering, status,
    // audit) and moves the compositions — attachments, comments and the
    // rest — along with the root.
    //
    // 'SAVE' against the ACTIVE entity is the supported programmatic entry
    // point: lean-draft rewrites it to draftActivate and builds the query
    // itself (see lean-draft.js, "support simple srv.send('SAVE',entity,...)").
    // Sending 'draftActivate' directly does not work — that event is only
    // produced inside the draft dispatcher, so it finds no handler.
    await srv.send('SAVE', srv.entities.Tickets.name, { ID });

    return SELECT.one.from(cds.entities('ITSMService').Tickets).where({ ID });
}


/* ---------------------------------------------------------
 * Stamp the number and the initial status as the draft is
 * activated. Only ever fills blanks, so re-saving an existing
 * ticket never renumbers it or resets its status.
 * ------------------------------------------------------- */
async function beforeSaveStampNumberAndStatus(req) {
    const { Tickets } = cds.entities('ITSMService');

    // req.data carries only what changed, so read the row for the fields
    // needed to decide — the ticket type drives the prefix, and an existing
    // number or status must not be overwritten.
    const current = req.data.ID
        ? await SELECT.one.from(Tickets)
            .columns('ticketNumber', 'status_ID', 'ticketType_ID', 'reportedBy_ID')
            .where({ ID: req.data.ID })
        : null;

    const ticketNumber = req.data.ticketNumber || (current && current.ticketNumber);
    const ticketTypeId = req.data.ticketType_ID !== undefined
        ? req.data.ticketType_ID
        : (current && current.ticketType_ID);

    // No number yet means this is the first activation — the Save half of
    // the two-phase create. Every later save is an edit and must leave both
    // the number and whatever status the ticket has reached alone.
    const isFirstSave = !ticketNumber;
    if (!isFirstSave) return;

    req.data.ticketNumber = await nextTicketNumberFor(ticketTypeId);

    // Forced, not defaulted. The create form pre-selects the STATUS marked
    // isDefault (New), so a "only fill it if empty" rule would let a brand
    // new ticket skip DRAFT entirely and never offer Submit.
    const draftStatusId = await statusIdByCode(STATUS_DRAFT);
    if (draftStatusId) req.data.status_ID = draftStatusId;

    // The DRAFT visibility rule keys off reportedBy, so a ticket that
    // reaches the active table without one would be invisible to everybody
    // — including the person who just created it. Default it to the author
    // here rather than trusting the form to always send it.
    const reportedBy = req.data.reportedBy_ID !== undefined
        ? req.data.reportedBy_ID
        : (current && current.reportedBy_ID);
    if (!reportedBy) {
        req.data.reportedBy_ID = await resolveCurrentUserId(req);
    }
}


/* ---------------------------------------------------------
 * SUBMIT (phase 2)
 * ------------------------------------------------------- */
async function onSubmitTicket(req) {
    const { ID } = req.params[req.params.length - 1];

    // Straight at the persistence entity: this acts on the already-active
    // row, and going through the draft-enabled projection would drag in the
    // draft round-trip this action exists to avoid.
    const { Ticket, TicketHistory } = cds.entities('itsm.txn');
    const { LookupValue } = cds.entities('itsm.master');

    const ticket = await SELECT.one.from(Ticket).columns('ID', 'status_ID', 'reportedBy_ID').where({ ID });
    if (!ticket) return req.reject(404, 'Ticket not found.');

    // A DRAFT ticket is private to its reporter, and the before-READ rule
    // in visibility.js only hides it from queries — this action reads the
    // persistence entity directly, so without this check anyone holding the
    // id could submit somebody else's unfinished ticket.
    const meId = await resolveCurrentUserId(req);
    if (!meId || ticket.reportedBy_ID !== meId) {
        return req.reject(403, 'Only the reporter of a ticket can submit it.');
    }

    const currentStatus = ticket.status_ID
        ? await SELECT.one.from(LookupValue).columns('code').where({ ID: ticket.status_ID })
        : null;
    const currentCode = currentStatus && currentStatus.code;

    if (currentCode !== STATUS_DRAFT) {
        return req.reject(400,
            `Only a ticket in ${STATUS_DRAFT} status can be submitted (this one is ${currentCode || 'unset'}).`);
    }

    const submittedId = await statusIdByCode(STATUS_SUBMITTED);
    if (!submittedId) {
        return req.reject(500, `No STATUS lookup value with code ${STATUS_SUBMITTED} exists.`);
    }

    await UPDATE(Ticket).set({ status_ID: submittedId }).where({ ID });

    await INSERT.into(TicketHistory).entries({
        ticket_ID: ID,
        fieldName: 'status',
        oldValue: STATUS_DRAFT,
        newValue: STATUS_SUBMITTED,
        changedBy_ID: await resolveCurrentUserId(req)
    });

    return SELECT.one.from(cds.entities('ITSMService').Tickets).where({ ID });
}


/* =========================================================
   Numbering helpers
   ========================================================= */

async function statusIdByCode(code) {
    const { LookupValue } = cds.entities('itsm.master');
    const row = await SELECT.one.from(LookupValue).columns('ID')
        .where({ lookupType: 'STATUS', code });
    return row ? row.ID : null;
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
 * `UPDATE ... SET lastNumber = lastNumber + 1` is evaluated by the database,
 * not read-modify-written in Node, so two concurrent saves cannot compute the
 * same value from a stale read. The row is write-locked by that statement for
 * the rest of the transaction, so the SELECT that follows sees this
 * transaction's own value and a competing save blocks until we commit.
 *
 * Doing it the obvious way instead — SELECT lastNumber, then UPDATE to
 * lastNumber + 1 — is exactly the race this avoids: both readers would see
 * the same value and hand out the same ticket number.
 */
async function reserveNextNumber(prefix) {
    const { TicketCounter } = cds.entities('itsm.master');

    const updated = await UPDATE(TicketCounter)
        .set({ lastNumber: { '+=': 1 } })
        .where({ prefix });

    // No counter row for this prefix yet (a prefix added after the seed data
    // was loaded). Create it, then take its first number.
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
    const number = await reserveNextNumber(prefix);
    return formatTicketNumber(prefix, number);
}


module.exports.PREFIX_BY_TICKET_TYPE = PREFIX_BY_TICKET_TYPE;
module.exports.DEFAULT_PREFIX = DEFAULT_PREFIX;
module.exports.formatTicketNumber = formatTicketNumber;
module.exports.prefixForTicketType = prefixForTicketType;
