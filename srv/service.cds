using { itsm.master as master, itsm.txn as txn } from '../db/schema';

@path: '/odata/v4/itsm'
service ITSMService {

    /*=====================================================
        MASTER DATA
        Full CRUD — maintained by admins, referenced
        everywhere else by association.
    =====================================================*/
    entity LookupValues       as projection on master.LookupValue;
    entity Users               as projection on master.User;
    entity SupportTeams        as projection on master.SupportTeam;
    entity Systems              as projection on master.SystemMaster;
    entity SoftwareComponents  as projection on master.SoftwareComponent;
    entity ConfigurationItems  as projection on master.ConfigurationItem;

    /*=====================================================
        TICKET — draft-enabled aggregate root.
        `history` is excluded here (see TicketHistory below):
        it's an append-only audit trail written by this
        service's own handlers, not something a user should
        be able to add/remove rows to while editing a draft.
    =====================================================*/
    @odata.draft.enabled
    entity Tickets as projection on txn.Ticket excluding { history };

    entity Attachments          as projection on txn.Attachment;
    entity TicketSAPNotes       as projection on txn.TicketSAPNote;
    entity SAPNoteSearchCriteria as projection on txn.SAPNoteSearchCriteria;
    entity TicketTransactions   as projection on txn.TicketTransaction;
    entity ScheduledActions     as projection on txn.ScheduledAction;
    entity TicketComments       as projection on txn.TicketComment;

    // Append-only audit trail: written by server-side handlers on
    // every Ticket SAVE, never directly writable through the API.
    @readonly
    entity TicketHistory as projection on txn.TicketHistory;

    // Read-only preview of the next ticket number, for display on the
    // create form before the ticket is actually saved. The authoritative
    // number is (re)assigned server-side on SAVE.
    function nextTicketNumber() returns String;
}
