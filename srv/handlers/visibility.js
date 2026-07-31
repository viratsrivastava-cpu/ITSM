const cds = require('@sap/cds');
const { resolveCurrentUserId } = require('./defaults');

/* =========================================================
   DRAFT-status tickets are private to their reporter.

   A ticket saved but not yet submitted is the reporter's own
   work in progress — the Service Group and everybody else only
   see it once it reaches SUBMITTED.

   Implemented as a before-READ filter rather than a `where` on
   the projection for two reasons:
     - the rule needs the master.User row matching the request
       user, which is a lookup, not something a static `where`
       can express;
     - a projection `where` also applies to the CAP draft rows
       (IsActiveEntity = false), whose status is still null while
       the form is being filled in, and `status.code <> 'DRAFT'`
       is NULL — not true — for those, so the author would lose
       sight of their own unsaved draft.

   Note this is a visibility rule, not an authorization boundary
   for a determined caller: a ticket read by key still goes
   through here, but nothing stops a user who knows an ID from
   probing. Tighten with @restrict if that matters.
   ========================================================= */

const STATUS_DRAFT = 'DRAFT';

module.exports = function registerVisibility(srv) {

    const { Tickets } = srv.entities;

    srv.before('READ', Tickets, async (req) => {
        // Requests for the draft half of the draft-enabled entity are the
        // user's own edit buffer; CAP already scopes those per user.
        if (req.target && req.target.name && req.target.name.endsWith('.drafts')) return;

        const draftStatus = await SELECT.one
            .from(cds.entities('itsm.master').LookupValue)
            .columns('ID')
            .where({ lookupType: 'STATUS', code: STATUS_DRAFT });

        // No DRAFT status configured — nothing to hide.
        if (!draftStatus) return;

        const meId = await resolveCurrentUserId(req);

        if (meId) {
            // Everything that is not in DRAFT, plus my own drafts.
            req.query.where(
                `(status_ID != ${quote(draftStatus.ID)} or status_ID is null)`
                + ` or reportedBy_ID = ${quote(meId)}`
            );
        } else {
            // Signed in but with no matching master.User row: there is no
            // "mine" to widen the rule with, so only non-draft tickets show.
            req.query.where(
                `status_ID != ${quote(draftStatus.ID)} or status_ID is null`
            );
        }
    });
};


// CQL string fragments are built here rather than passed as parameters
// because req.query.where(<string>) does not bind values. The ids come from
// the database and the user session, never from request payload, and are
// UUIDs — but quote defensively anyway so a stray quote cannot break out.
function quote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}
