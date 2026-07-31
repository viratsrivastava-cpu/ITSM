const cds = require('@sap/cds');
const { validateCategoryValues } = require('./categories');

/* ===================================================================
   CUSTOM CREATE TICKET API  —  the whole create flow, in one file.

   Reading order matches execution order:

       1. Register            the action, and close the default POST
       2. Validate request    is the payload shaped correctly at all?
       3. Business rules      mandatory fields, lookups, references
       4. Enrich payload      user fields (whitelisted) + backend fields
       5. Persist             one INSERT, form included
       6. Build response      read back what was actually stored
       7. Helpers             numbering, lookup checks

   WHY AN ACTION (and not the alternatives)

     Function      OData functions are side-effect free and invoked
                   with GET. Creating a row is a side effect.

     Event         cds events (emit/on) are asynchronous and return
                   nothing to the caller. The UI needs the created
                   ticket back in the same round-trip. Events are the
                   right tool for announcing that a ticket WAS
                   created, not for creating one.

     on('CREATE')  Keeps the default POST /Tickets. Idiomatic, but the
                   ENTITY TYPE stays the contract, so status,
                   ticketNumber and reportedBy remain writable in the
                   metadata and can only be stripped by convention in
                   handler code.

     Action  ✅    The typed parameter list IS the contract. The
                   system-managed fields do not exist as inputs, so a
                   client cannot supply them at all — the guarantee is
                   structural rather than conventional. Confirmed: a
                   payload containing "status" is rejected by CAP with
                   `Property "status" does not exist in ticket` before
                   any handler runs.

   Action stays the right choice, so it is kept.
   =================================================================== */


/* ===================================================================
   CONSTANTS
   =================================================================== */

// Ticket number prefix per ticket type. Adding a type is one line here.
const PREFIX_BY_TICKET_TYPE = {
    INCIDENT: 'INC',
    SERVICE_REQUEST: 'SRV',
    PROBLEM: 'PRB',
    CHANGE: 'CHG'
};
const DEFAULT_PREFIX = 'INC';
const NUMBER_DIGITS = 7;

// The workflow state every new ticket starts in. Save must not advance
// the workflow — only an explicit Submit moves DRAFT -> SUBMITTED.
const INITIAL_STATUS = 'DRAFT';

// Fields the caller MAY contribute, on the ticket header.
// A whitelist, deliberately — see the enrichment section for why.
const USER_EDITABLE_HEADER = [
    'ticketType',
    'shortDescription',
    'priority',
    'supportTeam',
    'messageProcessor'
];

// Fields the caller MAY contribute, on the incident form.
const USER_EDITABLE_FORM = [
    'description',
    'category1', 'category2', 'category3', 'category4',
    'impact', 'urgency', 'language', 'isStandard',
    'softwareVersion', 'supportPackage', 'relatedRFC'
];

// Form associations. CAP expects the foreign-key column on insert, so the
// plain input name is mapped to its _ID column.
const USER_EDITABLE_FORM_ASSOCIATIONS = {
    system: 'system_ID',
    softwareComponent: 'softwareComponent_ID',
    configurationItem: 'configurationItem_ID'
};

// Mandatory user input. Everything else is optional.
const REQUIRED_FIELDS = {
    ticketType: 'Ticket Type',
    shortDescription: 'Short Description'
};

// Coded fields and the LookupValue type each must resolve against.
const CODED_HEADER_FIELDS = { ticketType: 'TICKET_TYPE', priority: 'PRIORITY' };
const CODED_FORM_FIELDS = { impact: 'IMPACT', urgency: 'URGENCY', language: 'LANGUAGE' };

// Master-data references: [input field, entity, key column, label].
const FORM_REFERENCES = [
    ['system', 'SystemMaster', 'ID', 'system'],
    ['softwareComponent', 'SoftwareComponent', 'ID', 'software component'],
    ['configurationItem', 'ConfigurationItem', 'ID', 'configuration item']
];

// Marks the one INSERT this action performs, so the guard below can tell
// it apart from a client POSTing straight at the entity set.
const VIA_ACTION = Symbol.for('itsm.createTicket');


/* ===================================================================
   1. REGISTER ACTIONS
   ===================================================================
   Two registrations, and they work as a pair: the action is the way
   in, and the guard closes the door behind it.
   =================================================================== */

module.exports = function registerCreateTicket(srv) {

    // The custom Create API itself.
    srv.on('createTicket', (req) => onCreateTicket(req, srv));

    // Tickets are raised through createTicket only.
    //
    // Why a guard and not @Capabilities.InsertRestrictions.Insertable:
    // that annotation is enforced for INTERNAL srv.run(INSERT) too, so it
    // would block this action's own persistence step and force it to write
    // straight to the database — bypassing CAP's managed-field defaulting
    // and every other CREATE handler. Verified: the annotation produced
    // `Entity "Tickets" is not insertable` for our own insert.
    srv.before('CREATE', srv.entities.Tickets, (req) => {
        const stamped = cds.context && cds.context[VIA_ACTION];

        if (!stamped) {
            return req.reject(405,
                'Tickets cannot be POSTed directly. Use the createTicket action.');
        }

        // Re-apply the backend-managed fields that CAP strips from write
        // payloads. ticketNumber is annotated @readonly (app/annotations.cds)
        // so a client can never PATCH it — but that also removes it from OUR
        // insert, which silently stored a ticket with a null number. Applying
        // it here, after input processing, keeps both guarantees: readonly to
        // the outside, always populated from inside.
        Object.assign(req.data, stamped);
    });
};


/* ===================================================================
   ORCHESTRATION
   ===================================================================
   Deliberately thin and linear, so the whole flow is readable at a
   glance. Each step is a section below.
   =================================================================== */

async function onCreateTicket(req, srv) {

    // ---- 2. Validate the request shape -----------------------------
    const input = validateRequest(req);
    if (!input) return;                       // req.reject already called

    // ---- 3. Business rules -----------------------------------------
    // req.error collects problems rather than throwing on the first one,
    // so the UI can show every issue at once instead of making the user
    // resubmit repeatedly.
    await applyBusinessValidations(req, input);
    if (req.errors) return;                   // request already failed

    // ---- 4. Enrich --------------------------------------------------
    const payload = await enrichPayload(req, input);

    // ---- 5. Persist -------------------------------------------------
    const ticketID = await persistTicket(srv, payload);

    // ---- 6. Respond -------------------------------------------------
    return buildResponse(srv, req, ticketID);
}


/* ===================================================================
   2. VALIDATE INCOMING REQUEST
   ===================================================================
   Structural checks only: is there a payload at all? The typed action
   signature has already guaranteed that no unknown or system-managed
   property can be present, so there is nothing to strip here.
   =================================================================== */

function validateRequest(req) {
    const input = req.data && req.data.ticket;

    if (!input || typeof input !== 'object') {
        req.reject(400, 'A ticket payload is required.', 'ticket');
        return null;
    }

    // Normalised so every later step can read input.form without guarding.
    if (!input.form || typeof input.form !== 'object') input.form = {};

    return input;
}


/* ===================================================================
   3. BUSINESS RULES
   ===================================================================
   Everything a caller can get wrong, checked before anything is
   written. All errors carry a `target` so the UI can highlight the
   offending field.
   =================================================================== */

async function applyBusinessValidations(req, input) {
    const form = input.form;

    // 3a. Mandatory fields.
    for (const [field, label] of Object.entries(REQUIRED_FIELDS)) {
        if (isBlank(input[field])) {
            req.error(400, `${label} is required.`, `ticket/${field}`);
        }
    }

    // 3b. Coded fields must name a real, active LookupValue of their type.
    await validateCodes(req, input, CODED_HEADER_FIELDS, 'ticket');
    await validateCodes(req, form, CODED_FORM_FIELDS, 'ticket/form');

    // 3c. People and teams must exist. These are plain code columns since
    //     the entity split, so nothing else enforces referential integrity.
    await validateReference(req, 'User', 'userId', input.messageProcessor,
        'ticket/messageProcessor', 'engineer');
    await validateReference(req, 'SupportTeam', 'teamCode', input.supportTeam,
        'ticket/supportTeam', 'support team');

    // 3d. Master-data references on the form.
    for (const [field, entity, key, label] of FORM_REFERENCES) {
        await validateReference(req, entity, key, form[field],
            `ticket/form/${field}`, label);
    }

    // 3e. Category hierarchy. Reuses the shared validator rather than
    //     restating the rule: the same check guards direct form edits, and
    //     two copies would drift apart as master data changes.
    //
    //     It has to be called explicitly because a form created as a nested
    //     composition (the deep insert below) does NOT raise its own CREATE
    //     event, so before('CREATE', IncidentForms) never sees it.
    await validateCategoryValues(req, form, 'ticket/form/');

    // 3f. Simple field-level rules.
    if (form.supportPackage != null && Number(form.supportPackage) < 0) {
        req.error(400, 'Support Package cannot be negative.', 'ticket/form/supportPackage');
    }
}


/* ===================================================================
   4. PAYLOAD ENRICHMENT
   ===================================================================
   Turns validated input into the exact row to be inserted.

   Two halves:
     - user fields, copied through a WHITELIST
     - backend fields, written unconditionally

   Why a whitelist and not "copy everything, then delete the system
   fields": blacklisting fails OPEN. Add a column to the schema and it
   silently becomes client-writable. A whitelist fails CLOSED — a new
   column is ignored until someone opts it in here.

   The backend values are assigned AFTER the user values, so even if a
   field somehow arrived from the client it is overwritten rather than
   honoured. (The typed action signature already makes that impossible;
   this ordering means the guarantee does not depend on it.)
   =================================================================== */

async function enrichPayload(req, input) {
    const payload = {};

    // ---- 4a. User-editable header fields (whitelisted) --------------
    for (const field of USER_EDITABLE_HEADER) {
        if (isProvided(input[field])) payload[field] = input[field];
    }

    // ---- 4b. User-editable form fields, as a deep insert ------------
    // The form travels with the ticket so the pair is created in one
    // transaction; a ticket can never end up without its form.
    payload.incidentForm = buildFormPayload(input.form);

    // ---- 4c. Backend-managed fields ---------------------------------

    // Ticket number: generated from an atomic per-prefix counter.
    // Never accepted from the client — two clients could otherwise claim
    // the same number, and the column is @assert.unique.
    payload.ticketNumber = await reserveTicketNumber(input.ticketType);

    // The key. ticketID is String(30) so it cannot hold a UUID; the
    // generated number serves as both, rather than a second surrogate
    // that would have to be kept in step.
    payload.ticketID = payload.ticketNumber;

    // Initial workflow state. Forced, not defaulted: creating a ticket
    // must not advance the workflow, and a client-supplied status would
    // let a ticket skip DRAFT and never be reviewed.
    payload.status = INITIAL_STATUS;

    // The reporter is whoever is signed in. Taken from the authenticated
    // identity, never from the payload — otherwise a caller could raise
    // tickets in someone else's name, and the DRAFT visibility rule
    // (which keys off reportedBy) would hide it from its real author.
    payload.reportedBy = currentUserId(req);

    // NOTE: createdAt / createdBy / modifiedAt / modifiedBy are NOT set
    // here. They carry @cds.on.insert and @readonly from the `managed`
    // aspect, so CAP fills them during the INSERT below. Setting them by
    // hand would be a second implementation of a rule the framework
    // already owns.

    return payload;
}


/** The incident-form half of the deep insert. */
function buildFormPayload(form) {
    const payload = {};

    for (const field of USER_EDITABLE_FORM) {
        if (isProvided(form[field])) payload[field] = form[field];
    }

    for (const [input, column] of Object.entries(USER_EDITABLE_FORM_ASSOCIATIONS)) {
        if (isProvided(form[input])) payload[column] = form[input];
    }

    return payload;
}


/* ===================================================================
   5. PERSIST TICKET
   ===================================================================
   One INSERT, through the SERVICE rather than straight to the
   database.

   That matters: going through srv.run keeps CAP's generic handlers in
   the loop, which is what fills the managed audit fields and applies
   the model's own constraints. A direct cds.db insert would skip all
   of it and the ticket would land without createdAt/createdBy.

   The context flag is what lets the guard in section 1 distinguish
   this insert from an external POST. It is cleared in `finally` so a
   failure cannot leave the door open for the rest of the request.
   =================================================================== */

async function persistTicket(srv, payload) {
    // Carries the fields CAP would strip (see the guard above) across into
    // the CREATE handler, and doubles as the "this insert is ours" marker.
    if (cds.context) {
        cds.context[VIA_ACTION] = {
            ticketID: payload.ticketID,
            ticketNumber: payload.ticketNumber
        };
    }

    try {
        await srv.run(INSERT.into(srv.entities.Tickets).entries(payload));
    } finally {
        if (cds.context) delete cds.context[VIA_ACTION];
    }

    // The key was computed during enrichment, so there is no need to dig
    // it out of the driver-specific INSERT result.
    return payload.ticketID;
}


/* ===================================================================
   6. BUILD RESPONSE
   ===================================================================
   The ticket is READ BACK rather than echoing the payload, so the
   caller sees exactly what was stored — including the audit fields CAP
   filled during the insert, which the payload never contained.
   =================================================================== */

async function buildResponse(srv, req, ticketID) {
    const ticket = await SELECT.one.from(srv.entities.Tickets).where({ ticketID });

    if (!ticket) {
        // Should be unreachable: the insert succeeded. If the row cannot be
        // read back it means a visibility rule is hiding it, which is worth
        // failing loudly rather than returning an empty body.
        return req.reject(500,
            `Ticket ${ticketID} was created but could not be read back.`);
    }

    return ticket;
}


/* ===================================================================
   7. HELPERS
   =================================================================== */

/**
 * Reserve the next number for the ticket type's prefix, atomically.
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
async function reserveTicketNumber(ticketTypeCode) {
    const prefix = PREFIX_BY_TICKET_TYPE[ticketTypeCode] || DEFAULT_PREFIX;
    const { TicketCounter } = cds.entities('itsm.master');

    const updated = await UPDATE(TicketCounter)
        .set({ lastNumber: { '+=': 1 } })
        .where({ prefix });

    // No counter row yet for this prefix (a type added after the seed data
    // was loaded). Create it and take its first number.
    if (!updated) {
        await INSERT.into(TicketCounter).entries({ prefix, lastNumber: 1 });
        return formatTicketNumber(prefix, 1);
    }

    const row = await SELECT.one.from(TicketCounter).columns('lastNumber').where({ prefix });
    return formatTicketNumber(prefix, row.lastNumber);
}


function formatTicketNumber(prefix, number) {
    return `${prefix}-${String(number).padStart(NUMBER_DIGITS, '0')}`;
}


/** Each coded field must name a real, active LookupValue of its type. */
async function validateCodes(req, source, mapping, path) {
    const { LookupValue } = cds.entities('itsm.master');

    for (const [field, lookupType] of Object.entries(mapping)) {
        const code = source[field];
        if (isBlank(code)) continue;

        const row = await SELECT.one.from(LookupValue).columns('code', 'isActive')
            .where({ lookupType, code });

        if (!row) {
            req.error(400,
                `"${code}" is not a valid ${lookupType.replace(/_/g, ' ').toLowerCase()}.`,
                `${path}/${field}`);
        } else if (row.isActive === false) {
            req.error(400, `"${code}" is no longer available for selection.`,
                `${path}/${field}`);
        }
    }
}


/** A referenced master-data row must exist. */
async function validateReference(req, entityName, keyField, value, path, label) {
    if (isBlank(value)) return;

    const entity = cds.entities('itsm.master')[entityName];
    const row = await SELECT.one.from(entity).columns(keyField).where({ [keyField]: value });
    if (!row) req.error(400, `No such ${label}: "${value}".`, path);
}


/**
 * The signed-in user. reportedBy holds a User.userId since the entity
 * split, which is exactly what the authenticated identity already is —
 * so no master.User round-trip is needed.
 */
function currentUserId(req) {
    const id = req.user && req.user.id;
    return (!id || id === 'anonymous') ? null : id;
}


function isBlank(v) { return v === undefined || v === null || String(v).trim() === ''; }
function isProvided(v) { return !isBlank(v) || v === false || v === 0; }


// Exported so the read-only nextTicketNumber() preview in handlers/tickets.js
// can show the same format without a second copy of the numbering rules.
module.exports.PREFIX_BY_TICKET_TYPE = PREFIX_BY_TICKET_TYPE;
module.exports.DEFAULT_PREFIX = DEFAULT_PREFIX;
module.exports.formatTicketNumber = formatTicketNumber;
