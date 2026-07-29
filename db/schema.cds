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
    Business events — created continuously, high volume
=========================================================*/
context txn {
 
    /*---------------------------------------------------------
        MAIN TICKET (merged Ticket + TicketForm)
    ---------------------------------------------------------*/
    @odata.draft.enabled
    @cds.search: { ticketNumber, shortDescription, description }
    entity Ticket : cuid, managed {

        // Header
        ticketNumber        : String(30) @assert.unique;
        ticketType          : Association to master.LookupValue;   // TICKET_TYPE
        shortDescription    : String(255);
        description         : LargeString;

        // People
        reportedBy          : Association to master.User;
        messageProcessor    : Association to master.User;
        supportTeam         : Association to master.SupportTeam;

        // Categorization
        category1           : Association to master.LookupValue;
        category2           : Association to master.LookupValue;
        category3           : Association to master.LookupValue;
        category4           : Association to master.LookupValue;
        solutionCategory    : Association to master.LookupValue;

        // Processing
        status              : Association to master.LookupValue;
        impact              : Association to master.LookupValue;
        urgency              : Association to master.LookupValue;
        priority            : Association to master.LookupValue;
        recommendedPriority : Association to master.LookupValue;

        // Language / flags
        language            : Association to master.LookupValue;
        isStandard          : Boolean default false;

        // System / component
        system              : Association to master.SystemMaster;
        softwareComponent   : Association to master.SoftwareComponent;
        softwareVersion     : String(50);
        supportPackage      : Integer;
        configurationItem   : Association to master.ConfigurationItem;
        relatedRFC          : String(30);

        // SLA
        firstResponseAt     : Timestamp;
        dueAt               : Timestamp;
        completedAt         : Timestamp;
        irtStatus           : Association to master.LookupValue;   // IRT_STATUS
        mptStatus           : Association to master.LookupValue;   // MPT_STATUS

        // Compositions (cascade delete + deep insert)
        attachments         : Composition of many Attachment            on attachments.ticket = $self;
        sapNotes            : Composition of many TicketSAPNote         on sapNotes.ticket = $self;
        transactions        : Composition of many TicketTransaction     on transactions.ticket = $self;
        scheduledActions    : Composition of many ScheduledAction       on scheduledActions.ticket = $self;
        comments            : Composition of many TicketComment         on comments.ticket = $self;
        history             : Composition of many TicketHistory         on history.ticket = $self;
        sapNoteSearch       : Composition of one  SAPNoteSearchCriteria on sapNoteSearch.ticket = $self;
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
        ticket        : Association to Ticket;
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
        ticket                    : Association to Ticket;
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
