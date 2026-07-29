const cds = require('@sap/cds');

module.exports = function registerCategories(srv) {

    const { Tickets } = srv.entities;

    // Validated on SAVE (draft activation) once the full record is final,
    // rather than on every intermediate draft PATCH.
    srv.before('SAVE', Tickets, validateCategories);

};


// The category hierarchy lives entirely in LookupValue.parent_ID. This
// handler never hardcodes which values belong to which parent — it only
// ever checks that each selected child's stored parent matches the level
// above it, so new levels/values are added in master data, not here.
async function validateCategories(req) {

    const { Tickets, LookupValues } = cds.entities('ITSMService');

    const levels = categoryLevels(Tickets);

    const touchesCategories = levels.some(level => level in req.data);
    if (!touchesCategories) return;

    const selected = levels.map(level => req.data[level] || null);
    const ids = selected.filter(Boolean);
    if (!ids.length) return;

    const rows = await SELECT.from(LookupValues)
        .columns('ID', 'name', 'parent_ID')
        .where({ ID: { in: ids } });

    const byId = new Map(rows.map(row => [row.ID, row]));

    for (let i = 0; i < levels.length; i++) {

        const childId = selected[i];
        if (!childId) continue;

        const child = byId.get(childId);
        if (!child) {
            req.error(400, `Category ${i + 1} is not a known category.`, levels[i]);
            continue;
        }

        const parentId = i === 0 ? null : selected[i - 1];
        if (i > 0 && !parentId) {
            req.error(400, `Category ${i + 1} requires Category ${i} to be selected.`, levels[i]);
            continue;
        }

        if ((child.parent_ID || null) !== parentId) {
            const parentName = parentId ? (byId.get(parentId) || {}).name || parentId : 'none';
            req.error(
                400,
                `"${child.name}" is not a valid Category ${i + 1} for the selected Category ${i || 1} ("${parentName}").`,
                levels[i]
            );
        }
    }
}


function categoryLevels(entity) {
    return Object.keys(entity.elements)
        .map(name => /^category(\d+)$/.exec(name))
        .filter(Boolean)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map(match => `${match[0]}_ID`);
}
