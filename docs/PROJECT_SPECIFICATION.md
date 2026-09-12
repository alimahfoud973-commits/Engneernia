# PROJECT SPECIFICATION
# Engineering Knowledge & Digital Resources Platform

> **Purpose:** This document is the master functional and architectural specification for rebuilding the platform from scratch in Claude Code.
>
> **Important:** Claude Code must analyze this specification first and must NOT begin major implementation until it has reviewed the requirements, proposed the architecture/database/permissions/payment approach, identified ambiguities, and received approval for the implementation plan.

---

## 1. Project Vision

The platform is a professional digital platform for engineering knowledge and digital resources.

The initial content originates from electrical engineering, but the platform must be designed from the beginning as a **multi-disciplinary engineering platform** covering:

1. Electrical Engineering
2. Mechanical Engineering
3. Architecture
4. Civil Engineering

The platform is not an open marketplace where every engineer can publish freely.

The platform owner controls publication and content quality.

Selected engineers can become approved contributors. The owner creates/authorizes their contributor accounts and controls which products they can publish or manage.

The long-term goal is to create a trusted engineering platform containing high-quality:

- Books and educational PDFs
- Engineering projects
- Excel calculation sheets
- CAD resources
- BIM/Revit resources
- Templates
- Design guides
- Engineering tools
- Other digital engineering resources

The platform should be designed so additional disciplines, content types, payment providers, and business models can be added later without rebuilding the core system.

---

# 2. Core Business Model

## 2.1 Platform Owner

There is one privileged platform owner / Super Admin.

The owner has full visibility and control over:

- All users
- All engineers/contributors
- All products
- All disciplines
- All categories
- All prices
- All commissions
- All sales
- All financial records
- All monthly settlements
- All payment methods
- All payment proofs
- All notifications
- Product publication
- Product deletion
- Product editing
- Engineer agreements
- Platform reports

The owner can upload files directly.

The owner is the final authority for publication.

---

# 3. User Roles and Permissions

The platform must have strict role-based access control.

## 3.1 Owner / Super Admin

Full access to everything.

Can:

- Create contributor accounts
- Disable contributors
- Assign disciplines
- Assign specific categories/products to contributors
- Upload products
- Edit products
- Delete products
- Change prices
- Change commissions
- Review sales
- Review financial ledgers
- Create and close monthly settlements
- Mark settlements as paid
- Configure payment methods
- Configure payment instructions
- View all engineers' sales
- View all platform revenue
- View all engineer earnings
- View all orders
- View all refunds
- Manage notifications
- Manage public content

## 3.2 Approved Engineer / Contributor

A contributor does NOT have general marketplace publishing privileges.

The owner must explicitly authorize the contributor.

A contributor can access only their own data.

They may be allowed to:

- Upload a draft product for review, if the owner enables this
- View their own products
- View the prices of their own products
- View their own sales
- View their own monthly statements
- View their own engineer share
- View the platform share associated with their own products
- View their own settlement status
- Receive notifications concerning their own products
- Edit/re-submit products when requested by the owner

They must NOT be able to see:

- Other engineers' sales
- Other engineers' earnings
- Other engineers' commissions
- Other engineers' product prices
- Other engineers' financial agreements
- Owner-wide financial reports
- Platform-wide financial performance
- Private agreements belonging to other contributors

### Critical security rule

Do not merely hide unauthorized financial information in the frontend.

Unauthorized financial data must NOT be returned by backend/API queries to unauthorized users.

Authorization must be enforced server-side and at the database/query layer where appropriate.

## 3.3 Customer / Public User

Customers can see only public product information, such as:

- Product title
- Discipline
- Category
- Description
- Public author/contributor name if desired
- Public preview
- Public price
- Public rating/review information if enabled
- File type
- Other intentionally public metadata

Customers must NOT see:

- Engineer commission
- Engineer percentage
- Platform percentage
- Engineer earnings
- Platform revenue
- Number of sales if the owner chooses not to expose it
- Private financial agreements
- Internal accounting information

---

# 4. Four Main Engineering Portals

The homepage must visibly present four major engineering disciplines directly.

1. **Electrical Engineering**
2. **Mechanical Engineering**
3. **Architecture**
4. **Civil Engineering**

Each discipline should behave as an independent portal/category tree while using the same underlying platform architecture.

The system must allow the owner to add future disciplines without restructuring the application.

---

# 5. Suggested Electrical Engineering Structure

Initial suggested categories:

- Strong Current / Power Systems
- Weak Current / ELV
- Solar Energy & Renewable Energy
- Medium Voltage / High Voltage
- Electrical Network Analysis
- Protection & Coordination
- Electrical Design
- Lighting Design
- Earthing & Lightning Protection
- Fire Alarm Systems
- CCTV & Security Systems
- Telecom / Structured Cabling
- Automation & PLC
- Electrical Engineering Software
- Excel Calculation Sheets
- Templates
- Engineering Projects
- Educational Books & Guides

Categories must be editable by the owner.

---

# 6. Suggested Civil Engineering Structure

Possible categories:

- Structural Engineering
- Reinforced Concrete
- Steel Structures
- Foundations
- Geotechnical Engineering
- Soil Mechanics
- Roads & Transportation
- Surveying
- Quantity Surveying
- Project Management
- Cost Estimation
- Specifications
- Water & Wastewater
- Hydraulic Engineering
- Civil Engineering Software
- AutoCAD / Civil 3D
- Excel Calculation Sheets
- Templates
- Engineering Projects
- Educational Books & Guides

---

# 7. Suggested Architecture Structure

Possible categories:

- Architectural Design
- Construction Drawings
- Architectural Details
- AutoCAD
- Revit Architecture
- BIM
- 3D Modeling
- 3D Visualization
- Interior Design
- Landscape
- Facades
- Sections & Elevations
- Codes & Specifications
- CAD Libraries
- BIM Libraries
- Templates
- Engineering/Architecture Projects
- Educational Books & Guides

---

# 8. Suggested Mechanical Engineering Structure

Possible categories:

- HVAC
- Plumbing
- Fire Fighting
- Mechanical Design
- Piping
- Mechanical Equipment
- Rotating Equipment
- Energy & Thermal Systems
- Maintenance
- MEP
- Revit MEP
- AutoCAD / Mechanical CAD
- Engineering Calculations
- Excel Calculation Sheets
- Templates
- Engineering Projects
- Educational Books & Guides

Categories are not permanently fixed. The owner must be able to add, edit, reorder, disable, or remove categories.

---

# 9. Product Model

A product can be:

- PDF
- Excel
- CAD
- Revit/BIM
- Template
- Project
- Other digital resource

Every product should contain structured metadata.

Suggested fields:

- Product ID
- Title
- Subtitle
- Description
- Discipline
- Category
- Subcategory if needed
- Contributor/Author
- File type
- File size
- Language
- Level (Beginner / Intermediate / Advanced)
- Software/technology
- Price
- Currency
- Preview
- Original file
- Publication status
- Approval status
- Created date
- Updated date
- Published date
- Sales count
- Rating/reviews if enabled

---

# 10. Product Ownership and Publication Workflow

The owner remains in control of all publication.

Recommended workflow:

```text
Draft
  ↓
Submitted for Review
  ↓
Admin Review
  ├── Rejected → Revision Required
  └── Approved
           ↓
       Published
           ↓
          Sale
```

The owner can also upload a product directly.

No product should become publicly available unless its status allows publication.

---

# 11. Dynamic Commission System

Commission is NOT a fixed $1.

The platform must support dynamic agreements.

The owner decides the financial agreement with each specific contributor and/or product.

Supported models should include at least:

### Percentage model

Example:

```text
Product Price: $10

Engineer: 90%
Platform: 10%

Engineer receives: $9
Platform receives: $1
```

Another product may use:

```text
Product Price: $20

Engineer: 80%
Platform: 20%

Engineer receives: $16
Platform receives: $4
```

### Fixed amount model

Example:

```text
Product Price: $15

Engineer fixed share: $11
Platform share: $4
```

The system should support a contributor-level default agreement and a product-level override.

Example:

```text
Contributor default:
Engineer 80%
Platform 20%

Specific Product:
Engineer 90%
Platform 10%
```

The owner controls this.

---

# 12. Financial Privacy

Commission agreements are private.

Only:

- Platform Owner
- The specific engineer/contributor concerned

may see the financial details of that contributor's products.

Other engineers must not see them.

Example:

Civil Engineer can see:

- Their own product price
- Their own commission
- Their own sales
- Their own earnings
- Platform share for their products

Civil Engineer cannot see:

- Mechanical Engineer's sales
- Mechanical Engineer's commission
- Mechanical Engineer's earnings
- Architecture Engineer's financial data

The same rule applies to all contributors.

The public sees only the public product price and intentionally public information.

---

# 13. Financial Snapshot at Time of Sale

Every completed sale must preserve the exact financial agreement that applied at the moment of purchase.

Do NOT recalculate old sales using the current commission.

Example:

```text
Order #1001
Sale price: $10
Engineer share at sale: 80%
Engineer amount: $8
Platform amount: $2
```

If the owner later changes the agreement to:

```text
Engineer: 70%
Platform: 30%
```

Order #1001 must remain:

```text
Engineer: $8
Platform: $2
```

This is mandatory.

The order/ledger must store a financial snapshot.

---

# 14. Financial Ledger

Each completed transaction must generate an immutable or properly auditable financial record.

Suggested information:

- Order ID
- Product ID
- Contributor ID
- Customer ID where appropriate
- Sale timestamp
- Sale price
- Currency
- Commission model
- Engineer percentage or fixed share
- Platform percentage or fixed share
- Engineer amount
- Platform amount
- Payment method
- Payment status
- Order status
- Refund status
- Settlement period
- Settlement ID when assigned

Do not rely on frontend calculations for financial truth.

Server-side calculations are authoritative.

---

# 15. Monthly Settlement System

The platform will NOT transfer the engineer's share after every sale.

Instead, sales are accumulated during the month.

At the beginning of the following month, the owner reviews and settles the engineer's accumulated balance.

Example:

During September:

```text
Product A
$10 × 5 = $50

Product B
$15 × 3 = $45

Product C
$20 × 2 = $40

Product D
$30 × 1 = $30

Gross Sales = $165
```

If the engineer receives 80%:

```text
Engineer Share = $132
Platform Share = $33
```

The engineer is paid monthly, not after each order.

---

# 16. Monthly Settlement Record

The system should generate a monthly statement such as:

```text
Settlement #SEP-2026-CIVIL

Engineer:
Civil Engineer

Period:
01/09/2026 → 30/09/2026

Total Orders:
11

Gross Sales:
$165

Engineer Earnings:
$132

Platform Revenue:
$33

Status:
Pending
```

Recommended status flow:

```text
PENDING
   ↓
APPROVED
   ↓
PAID
```

When paid, record:

- Payment date
- Amount
- Currency
- Payment method
- Payment reference/note
- Admin who marked it paid

Do not delete historical settlement records.

---

# 17. Refunds and Cancellations

The system must support refunds.

A refunded transaction must not remain incorrectly counted as a final sale.

Example:

```text
Sale:   +$20
Refund: -$20
```

The accounting system should calculate the net eligible amount according to the platform's configured rules.

Refund rules should be explicit and configurable where appropriate.

---

# 18. Monthly Engineer Dashboard

Each engineer should have a private dashboard.

Example:

```text
MY DASHBOARD

Current Month
-------------------------
Products Sold: 11
Gross Sales: $165

My Share: $132
Platform Share: $33

Settlement:
Pending
```

Historical statements:

```text
August 2026
Sales: $420
Engineer Share: $336
Platform Share: $84
Status: Paid

July 2026
Sales: $280
Engineer Share: $224
Platform Share: $56
Status: Paid
```

The engineer sees only their own historical data.

---

# 19. Owner Financial Dashboard

The owner should see all engineers.

Example:

```text
MONTHLY FINANCIAL REPORT

September 2026

Total Platform Sales: $4,820
Total Engineer Earnings: $3,700
Total Platform Revenue: $1,120
```

By contributor:

```text
Electrical Engineer
Sales: $1,430

Civil Engineer
Sales: $1,250

Architecture Engineer
Sales: $870

Mechanical Engineer
Sales: $640
```

The owner can drill down into individual contributors and products.

---

# 20. Payment Architecture

The platform must support multiple payment methods.

The payment system must be **modular, configurable, and provider-agnostic**.

Do not hard-code one payment provider as the only option.

Potential methods may include:

- Bank transfer
- ShamCash or other local payment method where legally and technically supported
- Credit/debit card provider
- PayPal if available and legally/operationally usable for the relevant customer/merchant setup
- Other future payment providers
- WhatsApp payment assistance / manual guidance

The availability of each method must be configurable.

---

# 21. Payment Method Manager

The owner should have:

```text
ADMIN → PAYMENT METHODS
```

with fields such as:

- Method name
- Display name
- Description
- Payment type
- Supported countries
- Supported currencies
- Instructions
- Account information
- Upload/payment-proof requirement
- Status: ON/OFF
- Sort order
- Optional provider configuration
- Customer support message

The owner must be able to:

- Add
- Edit
- Disable
- Enable
- Reorder
- Remove payment methods

without changing application code.

Sensitive credentials must not be stored in public frontend code.

---

# 22. Country-Based Payment Options

Payment options may depend dynamically on:

- Customer country
- Currency
- Product/currency
- Payment provider availability
- Owner configuration

Example:

### Customer in Syria

Possible options:

```text
ShamCash
Bank Transfer
Contact via WhatsApp
```

### Customer in Saudi Arabia

Possible options:

```text
Credit/Debit Card (if configured)
Bank Transfer (if configured)
PayPal (only if actually available/configured)
WhatsApp Assistance
```

The exact options must be controlled by the owner.

Do not promise a payment method merely because it exists in the interface.

---

# 23. WhatsApp Assistance

A permanent fallback should exist:

```text
Having trouble with payment?

[ Contact us on WhatsApp ]
```

The owner can configure the contact number and message.

Example prefilled message:

```text
Hello, I want to purchase:
[Product Name]
Order Reference:
[Order ID]
```

This must be configurable from Admin Settings.

---

# 24. Manual Payment Workflow

For bank transfer, local payment methods, or other manually verified payments:

```text
Customer selects method
        ↓
Payment instructions shown
        ↓
Customer pays
        ↓
Customer submits proof/reference
        ↓
Order = Pending Verification
        ↓
Admin reviews
        ├── Reject → Payment Issue
        └── Approve
               ↓
        Order = Paid/Completed
               ↓
        Product Access Granted
```

The owner controls final approval.

---

# 25. Payment vs Accounting Separation

Keep these systems logically separate:

```text
Payment Processing
        ↓
Order Confirmation
        ↓
Sales Ledger
        ↓
Commission Calculation
        ↓
Engineer Balance
        ↓
Monthly Settlement
```

Changing a payment provider must not require rebuilding the product/commission/accounting system.

---

# 26. Product Preview System

Public customers must be able to inspect the first five pages of a book/PDF before purchasing.

For a 120-page PDF:

```text
Public Preview:
Pages 1–5

Full file:
Pages 6–120 + original complete file
```

The customer should be able to decide whether the product is suitable before buying.

The owner should be able to configure the preview policy in the future, but the initial requirement is **5 pages**.

---

# 27. Preview Security

The original full file must NOT be publicly exposed.

Recommended architecture:

```text
Original File
     ↓
Private Storage
     ↓
Preview Generator
     ↓
Public Preview (first 5 pages)
```

After purchase:

```text
Purchase Verified
     ↓
Authorized Access
     ↓
Secure Download
```

Do not simply hide pages using frontend JavaScript.

The full file should not be retrievable through an unauthenticated public URL.

Preview pages may include a visible watermark such as:

```text
PREVIEW — ENGINEERING PLATFORM
```

---

# 28. Product Page

A public product page should include:

- Product title
- Discipline
- Category
- Public author name
- Description
- File type
- Language
- Level
- Software/technology if applicable
- Price
- Preview
- Public rating/reviews if enabled
- Purchase button

Do NOT expose:

- Commission
- Engineer share
- Platform share
- Internal sales/accounting information

---

# 29. Homepage Concept

The homepage should immediately communicate that this is a multi-disciplinary engineering platform.

Suggested structure:

```text
LOGO / BRAND
Search Engineering Resources

ENGINEERING KNOWLEDGE
& DIGITAL RESOURCES

[ ELECTRICAL ]
[ CIVIL ]
[ ARCHITECTURE ]
[ MECHANICAL ]

Featured Resources

Best Sellers

Free Resources

Engineering Experts / Contributors

Latest Publications
```

The four engineering disciplines should be visually prominent.

---

# 30. Search and Filtering

Search should eventually support filters such as:

### Discipline
- Electrical
- Civil
- Architecture
- Mechanical

### Category
Dynamic according to discipline.

### File type
- PDF
- Excel
- CAD
- Revit/BIM
- Template
- Project
- Other

### Level
- Beginner
- Intermediate
- Advanced

### Software / Technology
Dynamic.

### Price
- Free
- Paid
- Price range

Search and filters should be designed for hundreds or thousands of products.

---

# 31. Contributors / Engineer Profiles

Each approved contributor may have a public profile.

Example:

```text
Eng. Ahmed
Civil Engineer

Specialization:
Structural Engineering

Published Resources:
18
```

The public profile can show intentionally public information and published resources.

Private financial data must remain private.

---

# 32. Owner-Controlled Contributor System

The owner should be able to:

- Create contributor
- Activate/deactivate contributor
- Assign discipline
- Assign specialization
- Assign categories
- Configure default commission agreement
- Override commission for individual products
- Review contributor's products
- Review contributor's monthly sales
- Review contributor's settlements
- Send notifications

A future contributor should not automatically gain publication access merely by registering.

---

# 33. Notifications

Notifications must be targeted.

If the owner changes the price of a Civil Engineer's product:

```text
Owner changes price
       ↓
Notification
       ↓
ONLY responsible contributor
```

Do NOT broadcast private product/financial changes to all engineers.

Possible notifications:

- Product approved
- Product rejected
- Revision requested
- Product price changed
- Product unpublished
- Product published
- Monthly statement available
- Settlement approved
- Settlement paid

The owner can see all relevant notification history.

---

# 34. Price Change Rules

If the owner changes a product price:

1. Save the new price.
2. Record when it changed.
3. Preserve historical sale prices.
4. Recalculate future sales using the new price.
5. Notify only the responsible contributor when appropriate.
6. Do not alter old orders.

Historical transactions must remain unchanged.

---

# 35. Currency Architecture

Do not assume a single currency permanently.

The system should be designed to support:

- USD
- SAR
- SYP
- Other currencies in the future

Product pricing and payment methods should support configured currencies.

Financial calculations must store the currency explicitly.

Currency conversion, if introduced, must be auditable and must not silently alter historical transactions.

---

# 36. Security Requirements

Mandatory:

- Authentication
- Role-based authorization
- Server-side access control
- Secure file storage
- Protected downloads
- No public original-file URLs
- Secure payment-proof handling
- Audit logs for important financial/admin actions
- Input validation
- Secure password/session handling
- Protection against unauthorized API access
- Rate limiting where appropriate
- Backup strategy
- Error handling without exposing sensitive information

Financial and private contributor information requires especially strict access controls.

---

# 37. Audit Log

Important actions should be recorded.

Examples:

- Product created
- Product edited
- Product deleted/unpublished
- Price changed
- Commission changed
- Contributor created
- Contributor disabled
- Payment method changed
- Order manually approved
- Refund issued
- Settlement approved
- Settlement marked paid

Audit records should include timestamp, actor, action, and relevant entity/reference.

---

# 38. Admin Dashboard Sections

Suggested:

```text
Dashboard
Products
Disciplines
Categories
Contributors
Customers
Orders
Payments
Financial Ledger
Monthly Settlements
Commission Agreements
Payment Methods
Notifications
Reviews
Reports
Settings
Audit Logs
```

---

# 39. Contributor Dashboard Sections

Suggested:

```text
Dashboard
My Products
My Sales
Monthly Statements
My Earnings
Settlement History
Notifications
Profile
```

Do not include other contributors' data.

---

# 40. Customer Account

Suggested:

```text
My Account
My Purchases
My Downloads
Profile
Orders
Payment Status
Reviews
```

Purchased products should remain accessible according to the platform's rules.

---

# 41. Product Access After Purchase

After a verified successful purchase:

```text
Order Completed
      ↓
Customer entitlement created
      ↓
Secure download available
```

The system should track which customer owns/accesses which product.

Do not rely only on a success message on the frontend.

---

# 42. Free Products

The platform should support free resources.

Free products can help attract:

- Students
- Engineers
- Search traffic
- New users

Free resources should still use the same product architecture.

---

# 43. Bundles and Future Commercial Features

Design the architecture so future features can be added, such as:

- Product bundles
- Engineering packs
- Featured products
- Featured contributors
- Discounts
- Coupons
- Promotions
- Limited-time offers
- Recommendations
- Best sellers
- New releases

Do not implement unnecessary advanced features in the first version unless they are required.

The architecture should remain extensible.

---

# 44. Content Quality Strategy

The platform is intended to be trusted for engineering content.

The owner should maintain editorial control.

A future content-review workflow may include:

- Technical review
- Language review
- File quality check
- Preview check
- Metadata check
- Final approval

The goal is quality and usefulness, not simply a large number of files.

---

# 45. Recommended Homepage Sections

Initial homepage sections:

1. Four engineering disciplines
2. Featured resources
3. Best sellers
4. New releases
5. Free resources
6. Featured contributors
7. Latest publications
8. Search
9. Clear call-to-action for contributors
10. Payment/support information

---

# 46. Contributor Recruitment

The public should not be able to publish automatically.

Instead, provide:

```text
Are you an engineer with valuable resources?

[ Contact us to become a contributor ]
```

The owner evaluates the engineer and, if accepted, creates/authorizes their contributor account.

---

# 47. Recommended Database Concepts

The exact schema is to be designed by Claude Code after analyzing the whole specification.

At minimum, the architecture should account for entities similar to:

```text
Users
Roles
Contributors
Disciplines
Categories
Products
ProductFiles
ProductPreviews
Orders
OrderItems
Payments
PaymentProofs
FinancialLedger
CommissionAgreements
CommissionSnapshots
EngineerBalances
MonthlySettlements
SettlementItems
Refunds
Notifications
Entitlements
Reviews
AuditLogs
PaymentMethods
Settings
```

Do not blindly implement these names if the chosen framework/database suggests a better normalized design. Preserve the required business behavior.

---

# 48. Critical Accounting Principle

Never derive historical financial statements solely from the current product price or current commission settings.

Historical orders must contain the financial values applicable at the time of sale.

Monthly settlements should be generated from verified ledger/order records.

---

# 49. Critical Privacy Principle

There are three information levels:

## Public

- Product name
- Public description
- Public price
- Preview
- Public author information
- Public metadata

## Contributor-private

- Own sales
- Own product prices
- Own commission
- Own platform share
- Own earnings
- Own monthly statements
- Own settlement status

## Owner-only / privileged

- All contributors' data
- All products
- All commissions
- All agreements
- All platform revenue
- All financial reports
- All payment information
- All audit information

Claude Code must enforce these levels technically.

---

# 50. Development Method for Claude Code

Do not build the entire platform blindly in one step.

Use:

```text
Analyze
   ↓
Architecture Proposal
   ↓
Database Proposal
   ↓
Permission Model
   ↓
Payment Architecture
   ↓
Implementation Plan
   ↓
Approval
   ↓
Implement in small phases
   ↓
Test
   ↓
Review
   ↓
Continue
```

Before any major destructive change:

- Explain what will change.
- List affected files/modules.
- Explain risks.
- Wait for approval.

---

# 51. Claude Code Initial Instruction

After placing this document in the project, use an instruction similar to:

```text
You are the lead software architect and senior full-stack engineer for this project.

Read PROJECT_SPECIFICATION.md completely before modifying the project.

Do NOT start major implementation yet.

First:
1. Analyze the complete specification.
2. Inspect the existing project structure, if any.
3. Identify the current technology stack.
4. Propose the application architecture.
5. Propose the database schema and relationships.
6. Propose the RBAC/permission model.
7. Propose the secure file-storage and 5-page preview architecture.
8. Propose the modular payment architecture.
9. Propose the commission and monthly settlement architecture.
10. Explain how historical financial snapshots will be preserved.
11. Explain how contributor financial privacy will be enforced server-side.
12. Identify security risks.
13. Identify missing decisions or ambiguities.
14. Produce a phased implementation plan.

Do not delete, overwrite, migrate, or significantly modify existing files until I approve the plan.

Do not assume a specific payment provider unless explicitly approved.

The payment system must be modular and replaceable.

The commission system must be dynamic.

Monthly settlement is required; engineer payouts are not made after every sale.

The platform owner has full access.

Contributors can see only their own financial data.

Customers see only public product information.

The original full product file must never be publicly exposed.

The public preview is limited to the first 5 pages.

Wait for my approval after presenting the architecture and implementation plan.
```

---

# 52. Non-Negotiable Requirements

Claude Code must treat these as mandatory:

1. Multi-disciplinary platform from the beginning.
2. Four main disciplines: Electrical, Mechanical, Architecture, Civil.
3. Owner-controlled publication.
4. Selected engineers only can become contributors.
5. Dynamic commission, not a fixed $1.
6. Commission can be percentage or fixed amount.
7. Owner can set/modify price.
8. Owner can set/modify commission.
9. Private financial agreements.
10. Contributor sees only their own financial information.
11. Contributors cannot see each other's sales or commissions.
12. Public customers see only public product information.
13. Five-page public preview.
14. Original files stored privately.
15. Multiple configurable payment methods.
16. WhatsApp assistance option.
17. Manual payment verification support.
18. Payment provider must be replaceable.
19. Sales recorded in a financial ledger.
20. Engineer payouts handled monthly.
21. Monthly settlement statements.
22. Historical sale financial snapshots must never change.
23. Refunds must be accounted for.
24. Targeted notifications only.
25. Strong server-side authorization.
26. Audit logs for sensitive admin/financial actions.
27. Extensible architecture.
28. No major implementation before architecture approval.

---

# 53. Final Product Philosophy

The goal is not to build a website with many pages.

The goal is to build a **professional, scalable engineering platform** where:

- Engineering content is organized by discipline.
- The owner controls quality.
- Selected engineers can contribute.
- Customers can discover and buy useful resources.
- Payment methods can evolve by country.
- Contributor commissions remain private.
- Sales are accurately recorded.
- Monthly settlements are transparent to each contributor.
- The platform can grow from four initial disciplines to many more.

The system should prioritize:

**Security + correctness + usability + scalability + content quality**

over unnecessary visual complexity or unnecessary features.

