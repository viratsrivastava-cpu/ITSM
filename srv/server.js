const cds = require('@sap/cds');

/* =========================================================
   Suppress the browser's native Basic-auth dialog for XHR.

   With mocked/basic auth, CAP answers an unauthenticated request
   with `WWW-Authenticate: Basic realm="Users"`. A browser that sees
   that header on a credentialed request pops its own login dialog,
   which fights the application's own sign-in page.

   The obvious workaround — fetching with `credentials: "omit"` —
   suppresses the dialog but also drops cookies, and that breaks the
   app anywhere it is served through an authenticating reverse proxy
   (SAP Business Application Studio's port forwarding, most CF
   approuter setups): the proxy needs its session cookie, and without
   it rejects the request with its own 401 before CAP is ever
   reached. The symptom is "wrong username or password" for
   credentials that are perfectly valid.

   So the client now sends cookies, and the challenge header is
   stripped here instead — but only for requests that identify
   themselves as XHR. Ordinary browser navigation and API clients
   such as curl still get a normal 401 challenge.
   ========================================================= */

cds.on('bootstrap', (app) => {
    app.use((req, res, next) => {
        if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return next();

        const setHeader = res.setHeader.bind(res);
        res.setHeader = function (name, value) {
            if (String(name).toLowerCase() === 'www-authenticate') return res;
            return setHeader(name, value);
        };
        next();
    });
});

module.exports = cds.server;
