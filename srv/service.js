const cds = require('@sap/cds');

const registerNumbering = require('./handlers/numbering');
const registerCategories = require('./handlers/categories');
const registerAudit = require('./handlers/audit');
const registerAssignment = require('./handlers/assignment');
const { registerDefaults } = require('./handlers/defaults');

module.exports = cds.service.impl(async function () {
    registerNumbering(this);
    registerCategories(this);
    registerAudit(this);
    registerAssignment(this);
    registerDefaults(this);
});
