const cds = require('@sap/cds');


function currentUserId(req) {
    const id = req.user && req.user.id;
    return (!id || id === 'anonymous') ? null : id;
}


async function resolveUserKey(req) {
    const userId = currentUserId(req);
    if (!userId) return null;

    const { Users } = cds.entities('ITSMService');
    const user = await SELECT.one.from(Users).columns('ID').where({ userId });
    return user ? user.ID : null;
}


function keyOf(req, field) {
    if (req.data && req.data[field]) return req.data[field];
    const params = req.params && req.params[req.params.length - 1];
    if (!params) return null;
    return typeof params === 'object' ? params[field] : params;
}


module.exports = { currentUserId, resolveUserKey, keyOf };
