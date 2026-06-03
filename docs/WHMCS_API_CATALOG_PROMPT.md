# WHMCS External API — Full Action Catalog (Build Prompt)

You are building an MCP server or CLI over the WHMCS External API. Below is the full action catalog. Use it to plan coverage, classify read vs write, and gate destructive/financial actions.

The catalog is organized by the standard WHMCS External API categories as published on developers.whmcs.com ("API Reference"). Each table lists the real `CamelCase` action name, whether it is a Read (R) or Write (W) operation, its purpose, the most important parameters, and a risk classification: `none`, `financial`, `destructive`, or `security`. Actions whose existence or exact name could not be confirmed with high confidence are marked `(verify)` — treat those as candidates to confirm against the target install before wiring them up.

---

## Authentication

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `ValidateLogin` | W | Validate a client's email + password and return their client/user id | `email`, `password2` | security |
| `CreateSsoToken` | W | Mint a single-sign-on token to log a client into the client area or a service | `client_id`, `user_id`, `destination`, `service_id` | security |
| `CreateOAuthCredential` | W | Create an OAuth2 API credential (client id/secret) with grant types and scopes | `grantType`, `scope`, `name`, `description`, `serviceId` | security |
| `UpdateOAuthCredential` | W | Update an existing OAuth2 credential's scopes/grant types/status | `credentialId`, `scope`, `grantType`, `name`, `status` | security |
| `DeleteOAuthCredential` | W | Permanently delete an OAuth2 credential | `credentialId` | security |
| `ListOAuthCredentials` | R | List configured OAuth2 credentials | `grantType` | security |

## Affiliates

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetAffiliates` | R | List affiliate accounts and their balances/visitor counts | `limitstart`, `limitnum`, `userid` | none |
| `AffiliateActivate` | W | Activate the affiliate program for a given client | `userid` | none |

## Billing

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetInvoice` | R | Retrieve a single invoice with its line items and transactions | `invoiceid` | none |
| `GetInvoices` | R | List invoices, filterable by client/status/date | `userid`, `status`, `limitstart`, `limitnum` | none |
| `CreateInvoice` | W | Create a new invoice for a client with line items | `userid`, `status`, `itemdescription1`, `itemamount1`, `itemtaxed1` | financial |
| `UpdateInvoice` | W | Modify an invoice (status, items, dates, notes) | `invoiceid`, `status`, `itemdescription`, `newitemdescription` | financial |
| `DeleteInvoice` | W | Permanently delete an invoice | `invoiceid` | destructive |
| `AddInvoicePayment` | W | Record a payment against an invoice | `invoiceid`, `transid`, `gateway`, `date`, `amount` | financial |
| `CapturePayment` | W | Trigger capture of a payment on a pay method / invoice via the gateway | `invoiceid`, `cvv` | financial |
| `AddCredit` | W | Add account credit to a client | `clientid`, `description`, `amount`, `date` | financial |
| `ApplyCredit` | W | Apply existing client credit to an invoice | `invoiceid`, `amount` | financial |
| `GetCredits` | R | Retrieve a client's credit history | `clientid`, `limitstart`, `limitnum` | none |
| `AddTransaction` | W | Record a standalone transaction (not tied to invoice payment flow) | `paymentmethod`, `userid`, `invoiceid`, `transid`, `amountin`, `amountout` | financial |
| `UpdateTransaction` | W | Modify an existing transaction record | `transactionid`, `amountin`, `amountout`, `fees` | financial |
| `DeleteTransaction` | W | Delete a transaction record | `transactionid` | destructive |
| `GetTransactions` | R | List transactions, filterable by client/invoice/transid | `invoiceid`, `clientid`, `transid` | none |
| `AddBillableItem` | W | Add a billable item to a client for later invoicing | `clientid`, `description`, `amount`, `invoiceaction`, `recur` | financial |
| `UpdateBillableItem` | W | Update an existing billable item | `itemid`, `amount`, `description`, `invoiceaction` | financial |
| `DeleteBillableItem` | W | Delete a billable item | `billableid` | destructive |
| `GenInvoices` | W | Run the invoice generation routine (mass-create due invoices) | `clientid`, `noemails` | financial |
| `GetQuotes` | R | List quotes, filterable by stage/client | `limitstart`, `limitnum` | none |
| `CreateQuote` | W | Create a new quote with line items | `subject`, `proposal`, `userid`, `datecreated`, `validuntil`, `lineitems` | financial |
| `UpdateQuote` | W | Modify an existing quote | `quoteid`, `subject`, `stage`, `lineitems` | financial |
| `DeleteQuote` | W | Delete a quote | `quoteid` | destructive |
| `SendQuote` | W | Email a quote to the client | `quoteid` | none |
| `AcceptQuote` | W | Mark a quote as accepted (may generate invoice/order) | `quoteid` | financial |
| `GetPayMethods` | R | List stored pay methods (cards/bank) for a client | `clientId` | security |
| `AddPayMethod` | W | Add a stored pay method (card/bank token) for a client | `clientId`, `type`, `card_number`, `card_expiry`, `bank_account` | security |
| `DeletePayMethod` | W | Delete a stored pay method | `clientId`, `payMethodId` | destructive |
| `CreateInvoiceRefund` | W | Issue a refund against an invoice/transaction | `invoiceid`, `amount`, `transid`, `gateway` | financial |

## Client

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetClients` | R | List clients with search/filter | `limitstart`, `limitnum`, `search`, `status`, `sorting` | none |
| `GetClientsDetails` | R | Full detail for one client (profile, contacts, balances) | `clientid`, `email`, `stats` | none |
| `AddClient` | W | Create a new client account | `firstname`, `lastname`, `email`, `password2`, `country` | none |
| `UpdateClient` | W | Update a client profile/settings | `clientid`, `email`, `status`, `customfields` | none |
| `CloseClient` | W | Close (deactivate) a client account | `clientid` | none |
| `DeleteClient` | W | Permanently delete a client and associated data | `clientid`, `deleteusers`, `deletetransactions` | destructive |
| `GetClientsProducts` | R | List a client's products/services | `clientid`, `serviceid`, `domain`, `pid` | none |
| `GetClientsDomains` | R | List a client's registered domains | `clientid`, `domainid`, `domain` | none |
| `GetClientsAddons` | R | List a client's product addons | `clientid`, `serviceid`, `addonid` | none |
| `GetClientGroups` | R | List configured client groups | — | none |
| `GetCancelledPackages` | R | List packages with pending/processed cancellation requests | `limitstart`, `limitnum` | none |
| `GetContacts` | R | List sub-contacts, filterable by client | `userid`, `limitstart`, `limitnum` | none |
| `AddContact` | W | Add a sub-contact to a client | `clientid`, `firstname`, `lastname`, `email`, `permissions` | none |
| `UpdateContact` | W | Update an existing sub-contact | `contactid`, `email`, `permissions` | none |
| `DeleteContact` | W | Delete a sub-contact | `contactid` | destructive |
| `GetClientPassword` | R | Retrieve a client's (decrypted) password | `userid`, `email` | security |
| `GetEmails` | R | List emails sent to a client (email history) | `clientid`, `date`, `subject` | none |
| `ResetPasswordEmail` | W | Send a password-reset email to a client | `id`, `email` | security |

## Module / Provisioning (Service)

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `ModuleCreate` | W | Run the module's create/provision function for a service | `serviceid` | none |
| `ModuleSuspend` | W | Suspend a service via its module | `serviceid`, `suspendreason` | none |
| `ModuleUnsuspend` | W | Unsuspend a service via its module | `serviceid` | none |
| `ModuleTerminate` | W | Terminate a service via its module | `serviceid` | destructive |
| `ModuleChangePackage` | W | Push a package/config change to the module | `serviceid` | none |
| `ModuleChangePw` | W | Change the service password via the module | `serviceid`, `servicepassword` | security |
| `ModuleCustom` | W | Invoke a module's custom function | `serviceid`, `func_name` | none |
| `UpgradeProduct` | W | Create an upgrade/downgrade order for a service | `clientid`, `serviceid`, `type`, `newproductid`, `paymentmethod` | financial |
| `UpdateClientProduct` | W | Update a client's service record (price, status, dates, etc.) | `serviceid`, `status`, `recurringamount`, `nextduedate` | financial |

## Domains

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `DomainRegister` | W | Register a domain via its registrar module | `domainid` | financial |
| `DomainRenew` | W | Renew a domain via its registrar module | `domainid`, `regperiod` | financial |
| `DomainTransfer` | W | Initiate a domain transfer via the registrar | `domainid`, `eppcode` | financial |
| `DomainRelease` | W | Release a domain to a new registrar/tag | `domainid`, `newtag` | destructive |
| `DomainGetNameservers` | R | Get the current nameservers for a domain | `domainid` | none |
| `DomainUpdateNameservers` | W | Set the nameservers for a domain | `domainid`, `ns1`, `ns2`, `ns3` | none |
| `DomainGetLockingStatus` | R | Get the registrar lock status for a domain | `domainid` | none |
| `DomainUpdateLockingStatus` | W | Set the registrar lock status for a domain | `domainid`, `lockstatus` | none |
| `DomainToggleIdProtect` | W | Enable/disable WHOIS ID protection | `domainid`, `idprotect` | none |
| `DomainGetWhoisInfo` | R | Retrieve WHOIS/contact info for a domain | `domainid` | none |
| `DomainUpdateWhoisInfo` | W | Update WHOIS/contact info for a domain | `domainid`, `xml` | none |
| `DomainRequestEPP` | W | Request the EPP/auth code for a domain | `domainid` | none |
| `DomainWhois` | R | Look up raw WHOIS / availability for a domain string | `domain` | none |
| `UpdateClientDomain` | W | Update a client's domain record (status, dates, price) | `domainid`, `status`, `nextduedate`, `recurringamount` | financial |
| `GetTLDPricing` | R | Retrieve TLD register/transfer/renew pricing | `currencyid`, `clientid` | none |
| `GetRegistrars` | R | List activated registrar modules | — | none |
| `DomainRenewals` | R | List/inspect upcoming domain renewals *(verify)* | `domainid`, `userid` | none |

## Orders

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetOrders` | R | List orders, filterable by status/client/order id | `id`, `userid`, `status`, `limitstart` | none |
| `AddOrder` | W | Place a new order (products/domains/addons) for a client | `clientid`, `pid`, `domain`, `paymentmethod`, `billingcycle` | financial |
| `AcceptOrder` | W | Accept a pending order (provision + invoice) | `orderid`, `autosetup`, `sendemail` | financial |
| `PendingOrder` | W | Set an order back to pending | `orderid` | none |
| `CancelOrder` | W | Cancel an order | `orderid`, `cancelsub` | none |
| `DeleteOrder` | W | Permanently delete an order | `orderid` | destructive |
| `FraudOrder` | W | Flag an order as fraudulent | `orderid` | none |
| `OrderFraudCheck` | W | Run the configured fraud-check module against an order | `orderid` | none |
| `GetOrderStatuses` | R | List configured order statuses | — | none |
| `GetProducts` | R | List products/packages with pricing | `pid`, `gid`, `module` | none |
| `GetProductGroups` | R | List product groups *(verify)* | `gid` | none |
| `GetPromotions` | R | List configured promotions/coupons | `code` | none |
| `AddProduct` | W | Create a new product/package definition | `name`, `gid`, `type`, `paytype`, `pricing` | none |

## Support / Tickets

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetTickets` | R | List tickets, filterable by status/dept/client | `clientid`, `deptid`, `status`, `limitstart` | none |
| `GetTicket` | R | Retrieve a single ticket with its replies | `ticketid`, `ticketnum` | none |
| `OpenTicket` | W | Open a new support ticket | `deptid`, `subject`, `message`, `clientid`, `priority` | none |
| `AddTicketReply` | W | Add a reply to a ticket | `ticketid`, `message`, `clientid`/`adminusername` | none |
| `AddTicketNote` | W | Add an internal (staff) note to a ticket | `ticketid`, `message`, `markdown` | none |
| `UpdateTicket` | W | Update ticket fields (status, dept, priority, subject) | `ticketid`, `status`, `deptid`, `priority`, `flag` | none |
| `MergeTicket` | W | Merge one or more tickets into a target ticket | `ticketid`, `mergeticketids` | none |
| `DeleteTicket` | W | Permanently delete a ticket | `ticketid` | destructive |
| `GetTicketNotes` | R | List internal notes on a ticket | `ticketid` | none |
| `GetSupportDepartments` | R | List support departments and ticket counts | `ignore_dept_assignments` | none |
| `GetSupportStatuses` | R | List configured ticket statuses with counts | — | none |
| `GetTicketCounts` | R | Get ticket counts/awaiting-reply totals for the dashboard | `ignore_dept_assignments`, `status` | none |
| `GetTicketPredefinedReplies` | R | List predefined ticket replies | `categoryid`, `keyword` | none |
| `GetTicketPredefinedCats` | R | List predefined-reply categories | — | none |
| `GetTicketAttachment` | R | Retrieve a ticket attachment's contents | `relatedid`, `type`, `index` | none |
| `BlockTicketSender` | W | Block a ticket sender (and optionally delete their tickets) | `ticketid`, `email` | none |
| `AddCancelRequest` | W | Submit a cancellation request for a service | `serviceid`, `type`, `reason` | none |
| `AddAnnouncement` | W | Publish a support/news announcement | `date`, `title`, `announcement`, `published` | none |
| `GetAnnouncements` | R | List published announcements | `limitstart`, `limitnum` | none |

## Project Management

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetProjects` | R | List projects, filterable by status/admin | `limitstart`, `limitnum` | none |
| `GetProject` | R | Retrieve a single project with tasks/messages/logs | `projectid` | none |
| `CreateProject` | W | Create a new project | `title`, `adminid`, `userid`, `duedate` | none |
| `UpdateProject` | W | Update a project's fields | `projectid`, `title`, `status`, `adminid` | none |
| `DeleteProject` | W | Delete a project | `projectid` | destructive |
| `AddProjectTask` | W | Add a task to a project | `projectid`, `duedate`, `task`, `adminid` | none |
| `UpdateProjectTask` | W | Update a project task | `projectid`, `taskid`, `completed`, `duedate` | none |
| `EndTaskTimer` | W | Stop a running timer on a project task | `projectid`, `timerid`, `endtime` | none |
| `StartTaskTimer` | W | Start a timer on a project task *(verify)* | `projectid`, `taskid`, `adminid`, `start` | none |
| `AddProjectMessage` | W | Add a message to a project | `projectid`, `message`, `adminid` | none |
| `GetProjectRoles` | R | List project member roles *(verify)* | `projectid` | none |

## Users

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetUsers` | R | List user (login) accounts | `search`, `limitstart`, `limitnum` | none |
| `AddUser` | W | Create a new user (login) account | `firstname`, `lastname`, `email`, `password2` | none |
| `UpdateUser` | W | Update a user account's profile | `user_id`, `email`, `firstname`, `lastname` | none |
| `GetUserPermissions` | R | Get a user's permissions for a client relationship | `user_id`, `client_id` | security |
| `UpdateUserPermissions` | W | Set a user's permissions for a client relationship | `user_id`, `client_id`, `permissions` | security |
| `CreateClientInvite` | W | Invite a user to access a client account | `client_id`, `email`, `permissions` | security |
| `DeleteUserClient` | W | Remove a user's access to a client | `user_id`, `client_id` | destructive |
| `ResetPassword` | W | Reset a user's password | `user_id`, `email` | security |

## Servers

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetServers` | R | List provisioning servers and their load/limits | `serverid`, `fields` | none |
| `GetHealthStatus` | R | Retrieve system health-check status (queues, disk, etc.) | `fetchStatus` | none |

## System / Misc

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `GetStats` | R | Retrieve admin dashboard statistics (income, orders, tickets) | `timeline` | none |
| `GetActivityLog` | R | Retrieve the activity log | `limitstart`, `limitnum`, `userid`, `date` | none |
| `LogActivity` | W | Write an entry to the activity log | `description`, `userid` | none |
| `GetAdminDetails` | R | Get details for the calling admin (perms, dept access) | — | none |
| `GetAdminUsers` | R | List admin users | `roleid`, `email`, `include_disabled` | security |
| `GetStaffOnline` | R | List admins currently logged in | — | none |
| `GetAutomationLog` | R | Retrieve the automation/cron task log | `date`, `limitstart`, `limitnum` | none |
| `GetToDoItems` | R | List admin to-do items | `status`, `limitstart`, `limitnum` | none |
| `GetToDoItemStatuses` | R | List configured to-do statuses with counts | — | none |
| `UpdateToDoItem` | W | Update an admin to-do item *(verify)* | `itemid`, `status`, `note`, `duedate` | none |
| `GetCurrencies` | R | List configured currencies and exchange rates | — | none |
| `GetPaymentMethods` | R | List active payment gateways | — | none |
| `GetEmailTemplates` | R | List email templates | `type`, `language` | none |
| `GetConfigurationValue` | R | Read a WHMCS configuration setting | `setting` | security |
| `SetConfigurationValue` | W | Write a WHMCS configuration setting | `setting`, `value` | security |
| `SendEmail` | W | Send a client email (template or custom) | `messagename`, `id`, `customtype`, `custommessage`, `customsubject` | security |
| `SendAdminEmail` | W | Send an email to admins | `messagename`, `type`, `deptid`, `customsubject`, `custommessage` | none |
| `TriggerNotificationEvent` | W | Fire a notification-rule event into the notification system | `notification_identifier`, `title`, `message`, `attributes` | none |
| `WhmcsDetails` | R | Return WHMCS version and API/PHP environment details | — | none |
| `DecryptPassword` | W | Decrypt a value previously encrypted by WHMCS | `password2` | security |
| `EncryptPassword` | W | Encrypt a value using WHMCS encryption | `password2` | security |

## Addons

| Action | Type (R/W) | Purpose | Key params | Risk |
|---|---|---|---|---|
| `UpdateClientAddon` | W | Update a client's product addon (status, price, dates) | `id`, `status`, `recurringamount`, `nextduedate` | financial |
| `GetClientsAddons` | R | List a client's product addons *(verify — see Client category)* | `clientid`, `serviceid`, `addonid` | none |

---

## Build guidance

When implementing an MCP server or CLI on top of this catalog:

- **Classify every action as Read vs Write first.** Reads are safe to expose broadly; everything in the `W` column mutates the install and must be treated as privileged.
- **Put ALL writes behind a governed/confirmation flow.** Use a draft → validate → approve → execute pattern (write-intent), never fire a write directly from a free-form model call. Echo a human-readable preview of exactly what will change before execution.
- **HARD-BLOCK destructive and security actions by default.** At minimum the following should be disabled unless an operator explicitly opts in per-action: every `Delete*` (`DeleteInvoice`, `DeleteTransaction`, `DeleteBillableItem`, `DeleteQuote`, `DeletePayMethod`, `DeleteClient`, `DeleteContact`, `DeleteTicket`, `DeleteProject`, `DeleteOrder`, `DeleteUserClient`, `DeleteOAuthCredential`), `GetClientPassword`, `DomainTransfer`, `DomainRelease`, `SetConfigurationValue`, `SendEmail`, the OAuth credential CRUD (`CreateOAuthCredential`/`UpdateOAuthCredential`/`DeleteOAuthCredential`), and `ValidateLogin` / `CreateSsoToken`.
- **Never log or echo secrets or card data.** Do not write PANs, CVVs, `card_number`, `card_expiry`, decrypted passwords (`GetClientPassword`, `DecryptPassword`), SSO tokens, or OAuth secrets to logs, traces, or model context. Redact at the transport boundary.
- **WHMCS API permissions are per-credential-role.** An action existing in this catalog does not mean your credential can call it — probe reachability on the target install (call the action, inspect for a permission-denied result) and build a capability matrix rather than assuming.
- **WHMCS 8 vs 9 behavior can differ.** Action availability, parameter names, and response shapes (notably credit/debit-note and invoice-refund handling) vary between major versions. Test against both 8 and 9 where you support them.

---

> Note: This is a generic, provider-agnostic catalog of the WHMCS External API surface. It is not specific to any one WHMCS install — exact action availability, permissions, and parameters depend on the target version, activated modules, and the calling credential's role.
