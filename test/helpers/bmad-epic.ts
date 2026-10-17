/** A BMAD v7 epic folder (#429): the epic, its tickets.toml breakdown and
 * the architecture spine it references. */
export const EPIC = `---
type: epic
title: "Shoppers manage their cart"
covers: [R1, R2, R3]
risk: medium
---

# Shoppers manage their cart

## Description

A shopper adds items, changes quantities and applies discount codes.

## Requirements

- R1: Add, remove, and change quantity of any item; the total updates at once.
- R2: Apply one discount code; refused codes say why.
- R3: The total shown is the total charged, before tax.

## Done when

1. R1-R3 work end to end on the live site.

## References

- constraint — architecture-checkout/architecture-checkout.md, AD-1

## Notes

- Decision: codes are case-insensitive (2026-08-12).
`;
export const TICKETS = `# tickets.toml — the epic's agreed children. The order of the tables is the build order.

[[entry]]
id = 1
type = "story"
title = "Cart service scaffold"
description = "Stands up the cart service with one add-item path through UI, API, and store."
verify = "A shopper adds one item and sees it in the cart."
covers = ["R1"]
after = []
hitl = true
risk = "low"

[[entry]]
id = 2
type = "story"
title = "Apply and refuse discount codes"
description = "Adds code validation to the pricing call and shows the refusal reason."
verify = "A valid code lowers the total; an expired one is refused with its reason."
covers = ["R2"]
after = [1]
unknown = "Can the discount engine answer within 300 ms?"
risk = "medium"

[[entry]]
id = 3
type = "story"
title = "Shown total equals charged total"
description = "Sends the shown total to payment unchanged."
verify = "The payment request carries exactly the total the cart showed."
covers = ["R3"]
after = [2, "1.3"]
references = ["architecture-checkout/architecture-checkout.md#ad-1"]
risk = "medium"
`;
export const ARCHITECTURE = `---
name: 'checkout'
type: architecture-spine
---

# Architecture Spine — checkout

### AD-1 — Totals are computed once

- **Rule:** The pricing service alone computes totals; the cart never recomputes them.
`;
