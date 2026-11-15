# Simple Alerts

Simple Alerts receives error reports from monitored applications and notifies an operator through Telegram.

## Language

**Operator**:
The person who manages a Simple Alerts installation and investigates its reported errors.
_Avoid_: Customer, tenant

**Project**:
A monitored application whose error reports and notification settings are managed together.
_Avoid_: Service, site

**Error occurrence**:
An individual report of an error from a project, including its diagnostic context.
_Avoid_: Alert, notification

**Error group**:
A collection of occurrences within a project that represent the same underlying error.
_Avoid_: Issue, incident

**Alert**:
A notification about an error group, including an initial notification or a summary of repeated occurrences.
_Avoid_: Error occurrence, report

**Telegram destination**:
A Telegram chat to which a project's alerts are addressed.
_Avoid_: Channel, recipient

**Delivery attempt**:
An individual attempt to send an alert to its Telegram destination.
_Avoid_: Alert, error occurrence
