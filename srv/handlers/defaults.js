const cds = require('@sap/cds');

// Best-effort match of the authenticated request user to a master.User
// record (matched on userId). Returns null when there is no logged-in
// user or no matching User row — callers must tolerate a null result.
async function resolveCurrentUserId(req) {
    const username = req.user && req.user.id;
    if (!username || username === 'anonymous') return null;

    const { Users } = cds.entities('ITSMService');
    const user = await SELECT.one.from(Users).columns('ID').where({ userId: username });
    return user ? user.ID : null;
}


function registerDefaults(srv) {

    const { TicketComments } = srv.entities;

    srv.before('CREATE', TicketComments, async (req) => {
        if (req.data.author_ID) return;
        req.data.author_ID = await resolveCurrentUserId(req);
    });

}


module.exports = { registerDefaults, resolveCurrentUserId };
