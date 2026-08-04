const cds = require('@sap/cds');

const PREFIX_BY_TICKET_TYPE = {
    INCIDENT: 'INC',
    SERVICE_REQUEST: 'SRV',
    PROBLEM: 'PRB',
    CHANGE: 'CHG'
};
const DEFAULT_PREFIX = 'INC';
const NUMBER_DIGITS = 7;


async function generateTicketNumber(ticketTypeCode) {
    const prefix = PREFIX_BY_TICKET_TYPE[ticketTypeCode] || DEFAULT_PREFIX;
    const { TicketCounter } = cds.entities('itsm.master');

    const updated = await UPDATE(TicketCounter)
        .set({ lastNumber: { '+=': 1 } })
        .where({ prefix });

    if (!updated) {
        await INSERT.into(TicketCounter).entries({ prefix, lastNumber: 1 });
        return format(prefix, 1);
    }

    const row = await SELECT.one.from(TicketCounter).columns('lastNumber').where({ prefix });
    return format(prefix, row.lastNumber);
}

function format(prefix, number) {
    return `${prefix}-${String(number).padStart(NUMBER_DIGITS, '0')}`;
}

module.exports = { generateTicketNumber };
