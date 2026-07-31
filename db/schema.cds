namespace itsm;

using { cuid, managed } from '@sap/cds/common';


/*=========================================================
    MASTER DATA CONTEXT
    Reference data — rarely changes, referenced by transactions
=========================================================*/
context master {

    /*---------------------------------------------------------
        GENERIC LOOKUP TABLE
        Handles all dropdowns: STATUS, PRIORITY, IMPACT, URGENCY,
        CATEGORY1..4, SOLUTION_CATEGORY, LANGUAGE, TICKET_TYPE,
        IRT_STATUS, MPT_STATUS, FUZZY_THRESHOLD, RELEASED_ON,
        PROCESSING_TYPE, SAP_NOTE_STATUS, TRANSACTION_TYPE,
        TRANSACTION_STATUS, TRANSACTION_CATEGORY,
        SCHED_ACTION_STATUS
    ---------------------------------------------------------*/
    @assert.unique.typeCode: [lookupType, code]
    entity LookupValue : cuid, managed {
        lookupType   : String(50)  @assert.notNull;
        code         : String(50)  @assert.notNull;
        name         : localized String(100);
        description  : localized String(255);
        parent       : Association to LookupValue;
        sequence     : Integer;
        isDefault    : Boolean default false;
        isActive     : Boolean default true;
    }

    entity TicketCounter : managed {
    key prefix     : String(10);
        lastNumber : Integer default 00001;
    }   

    /*---------------------------------------------------------
        USERS
    ---------------------------------------------------------*/
    entity User : cuid, managed {
        userId    : String(50) @assert.unique;
        name      : String(100);
        email     : String(100);
        isActive  : Boolean default true;
    }

    /*---------------------------------------------------------
        SUPPORT TEAMS
    ---------------------------------------------------------*/
    entity SupportTeam : cuid, managed {
        teamCode  : String(50) @assert.unique;
        name      : String(100);
        isActive  : Boolean default true;
    }

    /*---------------------------------------------------------
        SYSTEMS (SAP landscape systems)
    ---------------------------------------------------------*/
    entity SystemMaster : cuid, managed {
        systemId    : String(50) @assert.unique;
        name        : String(100);
        description : String(255);
    }

    /*---------------------------------------------------------
        SOFTWARE COMPONENTS
    ---------------------------------------------------------*/
    entity SoftwareComponent : cuid, managed {
        componentCode : String(50) @assert.unique;
        name          : String(100);
    }

    /*---------------------------------------------------------
        CONFIGURATION ITEMS (CMDB)
    ---------------------------------------------------------*/
    entity ConfigurationItem : cuid, managed {
        ciCode      : String(50) @assert.unique;
        name        : String(100);
        description : String(255);
    }




}



/*=========================================================
    TRANSACTIONAL DATA CONTEXT
=========================================================*/
context txn {

    /*---------------------------------------------------------
        MAIN TICKET
    ---------------------------------------------------------*/
    @cds.search: { ticketNumber, shortDescription }
    entity Ticket : managed {

        // Identity
        key ticketID     : String(30);
        ticketNumber     : String(30) @assert.unique;
        ticketType       : String(50);

        // Generic information
        shortDescription : String(255);
        status           : String(50);
        priority         : String(50);

        // Ownership (UI-resolved codes/ids)
        reportedBy       : String(50);
        messageProcessor : String(50);
        supportTeam      : String(50);

        // SLA
        firstResponseAt  : Timestamp;
        dueAt            : Timestamp;
        completedAt      : Timestamp;

        // Child collections
        attachments      : Composition of many Attachment
                           on attachments.ticket = $self;

        comments         : Composition of many TicketComment
                           on comments.ticket = $self;

        history          : Composition of many TicketHistory
                           on history.ticket = $self;

        transactions     : Composition of many TicketTransaction
                           on transactions.ticket = $self;

        scheduledActions : Composition of many ScheduledAction
                           on scheduledActions.ticket = $self;

        incidentForm     : Composition of one IncidentForm
                           on incidentForm.ticket = $self;
    }

    /*---------------------------------------------------------
        INCIDENT FORM (1:1 with Ticket)
    ---------------------------------------------------------*/
    entity IncidentForm : cuid {

        ticket : Association to Ticket;

        description         : LargeString;

        // UI-managed dropdown values
        category1           : String(100);
        category2           : String(100);
        category3           : String(100);
        category4           : String(100);
        solutionCategory    : String(100);

        impact              : String(50);
        urgency             : String(50);
        recommendedPriority : String(50);

        language            : String(50);
        isStandard          : Boolean default false;

        // Master data relationships
        system              : Association to master.SystemMaster;
        softwareComponent   : Association to master.SoftwareComponent;
        softwareVersion     : String(50);
        supportPackage      : Integer;
        configurationItem   : Association to master.ConfigurationItem;
        relatedRFC          : String(30);

        irtStatus           : String(50);
        mptStatus           : String(50);

        sapNotes            : Composition of many TicketSAPNote
                              on sapNotes.ticketForm = $self;

        sapNoteSearch       : Composition of one SAPNoteSearchCriteria
                              on sapNoteSearch.ticketForm = $self;
    }

    /*---------------------------------------------------------
        ATTACHMENTS
    ---------------------------------------------------------*/
    entity Attachment : cuid, managed {
        ticket       : Association to Ticket;
        fileName     : String(255);
        originalName : String(255);
        mimeType     : String(100) @Core.IsMediaType;
        fileSize     : Integer;
        content      : LargeBinary @Core.MediaType: mimeType;
        storagePath  : String(500);
    }

    /*---------------------------------------------------------
        SAP NOTES ATTACHED TO TICKET
    ---------------------------------------------------------*/
    entity TicketSAPNote : cuid, managed {
        // Back-link to the form, not the ticket: SAP notes are part of the
        // incident form (see IncidentForm.sapNotes).
        ticketForm    : Association to IncidentForm;
        sapNoteNumber : String(20);
        description   : LargeString;
        details       : LargeString;
        component     : Association to master.SoftwareComponent;
        status        : Association to master.LookupValue;   // SAP_NOTE_STATUS
    }

    /*---------------------------------------------------------
        SAP NOTE SEARCH CRITERIA (search popup fields)
    ---------------------------------------------------------*/
    entity SAPNoteSearchCriteria : cuid, managed {
        // Back-link to the form, not the ticket (see IncidentForm.sapNoteSearch).
        ticketForm                : Association to IncidentForm;
        componentsStartWith       : String(100);
        componentsExact           : String(100);
        excludedComponents        : String(100);
        supportPackageGreaterThan : Integer;
        supportPackageEqual       : Integer;
        fuzzyThreshold            : Association to master.LookupValue;   // FUZZY_THRESHOLD
        releasedOnPreDefined      : Association to master.LookupValue;   // RELEASED_ON
        releasedOnFree            : Date;
    }

    /*---------------------------------------------------------
        RELATED TRANSACTIONS
    ---------------------------------------------------------*/
    entity TicketTransaction : cuid, managed {
        ticket          : Association to Ticket;
        transactionId   : String(30);
        transaction     : String(30);
        description     : String(255);
        category        : Association to master.LookupValue;   // TRANSACTION_CATEGORY
        status          : Association to master.LookupValue;   // TRANSACTION_STATUS
        priority        : Association to master.LookupValue;   // PRIORITY
        transactionType : Association to master.LookupValue;   // TRANSACTION_TYPE
    }

    /*---------------------------------------------------------
        SCHEDULED ACTIONS
    ---------------------------------------------------------*/
    entity ScheduledAction : cuid, managed {
        ticket           : Association to Ticket;
        actionDefinition : String(255);
        processingType   : Association to master.LookupValue;   // PROCESSING_TYPE
        status           : Association to master.LookupValue;   // SCHED_ACTION_STATUS
        executable       : Boolean default false;
        scheduledAt      : Timestamp;
    }

    /*---------------------------------------------------------
        COMMENTS
    ---------------------------------------------------------*/
    entity TicketComment : cuid, managed {
        ticket  : Association to Ticket;
        comment : LargeString;
        author  : Association to master.User;
    }

    /*---------------------------------------------------------
        HISTORY / AUDIT
    ---------------------------------------------------------*/
    entity TicketHistory : cuid, managed {
        ticket    : Association to Ticket;
        fieldName : String(100);
        oldValue  : LargeString;
        newValue  : LargeString;
        changedBy : Association to master.User;
    }
}
