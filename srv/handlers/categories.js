const cds = require('@sap/cds');

module.exports = function registerCategories(srv) {

    const { IncidentForms } = srv.entities;

    // The category fields moved to IncidentForm in the entity split, so
    // that is the entity to guard now. Both write events, because the
    // tree can be set at creation and changed later; `before`, so an
    // inconsistent hierarchy is refused while the request can still be
    // rejected rather than rolled back.
    srv.before('CREATE', IncidentForms, validateCategories);
    srv.before('UPDATE', IncidentForms, validateCategories);

    // The nested-deep-insert case (a form created together with its ticket)
    // is validated by handlers/create-ticket.js, which calls
    // validateCategoryValues directly — a nested composition does not raise
    // its own CREATE event, so the registrations above never see it.

};


// The category hierarchy lives entirely in LookupValue.parent_ID. This
// handler never hardcodes which values belong to which parent — it only
// ever checks that each selected child's stored parent matches the level
// above it, so new levels/values are added in master data, not here.
async function validateCategories(req) {
    return validateCategoryValues(req, req.data, '');
}


// `data` is the object holding the category columns — req.data for a direct
// form write, or the nested incidentForm for a deep insert. `prefix` keeps
// the error targets pointing at the right place in the payload.
async function validateCategoryValues(req, data, prefix) {

    const { IncidentForms, LookupValues } = cds.entities('ITSMService');

    const levels = categoryLevels(IncidentForms);

    const touchesCategories = levels.some(level => level in data);
    if (!touchesCategories) return;

    const selected = levels.map(level => data[level] || null);
    const ids = selected.filter(Boolean);
    if (!ids.length) return;

    // The columns hold category NAMES now, not LookupValue ids, so the
    // tree is walked by name. parent_ID still points at a row id, so the
    // parent's name is resolved through a second map.
    const rows = await SELECT.from(LookupValues)
        .columns('ID', 'name', 'parent_ID')
        .where({ name: { in: ids } });

    const nameById = new Map(rows.map(row => [row.ID, row.name]));
    const byId = new Map(rows.map(row => [row.name, {
        name: row.name,
        parent_ID: row.parent_ID ? (nameById.get(row.parent_ID) || row.parent_ID) : null
    }]));

    for (let i = 0; i < levels.length; i++) {

        const childId = selected[i];
        if (!childId) continue;

        const child = byId.get(childId);
        if (!child) {
            req.error(400, `Category ${i + 1} is not a known category.`, prefix + levels[i]);
            continue;
        }

        const parentId = i === 0 ? null : selected[i - 1];
        if (i > 0 && !parentId) {
            req.error(400, `Category ${i + 1} requires Category ${i} to be selected.`, prefix + levels[i]);
            continue;
        }

        if ((child.parent_ID || null) !== parentId) {
            const parentName = parentId ? (byId.get(parentId) || {}).name || parentId : 'none';
            req.error(
                400,
                `"${child.name}" is not a valid Category ${i + 1} for the selected Category ${i || 1} ("${parentName}").`,
                prefix + levels[i]
            );
        }
    }
}


function categoryLevels(entity) {
    return Object.keys(entity.elements)
        .map(name => /^category(\d+)$/.exec(name))
        .filter(Boolean)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map(match => match[0]);
}


// Exported so the custom create flow can apply the same rule to a form
// arriving as a nested composition. One implementation, two call sites.
module.exports.validateCategoryValues = validateCategoryValues;
