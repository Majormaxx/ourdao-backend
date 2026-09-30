import type { LoanRow } from '../types.js'

export type LoanWithDerived = LoanRow & {
  interest_charge: string | null
  repaid_amount: string | null
  repayment_progress_bps: number | null
}

interface WarnLogger {
  warn: (obj: object, msg: string) => void
}

// The amount columns are NUMERIC(40,0), so `pg` hands back plain decimal
// integer strings. Anything else — a scaled "100.00" after a careless type
// change, null, garbage — must not reach BigInt(), which throws SyntaxError
// (issue #195). Returns null rather than throwing so the caller can degrade a
// single row instead of failing the whole request.
export function parseIntegerAmount(value: unknown): bigint | null {
  // The member summary embeds loans through row_to_json, where NUMERIC
  // arrives as a JSON number rather than a string.
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) return null
  return BigInt(value)
}

// A loan's interest charge and repayment progress aren't stored columns —
// both derive from total_repayment, which issue #11 added — so compute them
// at read time rather than duplicating state that could drift out of sync.
// BigInt (not Number) because these are NUMERIC(40,0) decimal strings that
// can exceed Number.MAX_SAFE_INTEGER.
//
// Issue #195: a malformed amount fails that row's derived fields only — they
// come back as null and the problem is logged with the loan id — rather than
// turning /api/loans, /api/loans/:id and the member summary into a 500.
export function withLoanDerived(loan: LoanRow, log?: WarnLogger): LoanWithDerived {
  const totalRepayment = parseIntegerAmount(loan.total_repayment)
  const amount = parseIntegerAmount(loan.amount)
  const outstanding = parseIntegerAmount(loan.outstanding)
  if (totalRepayment === null || amount === null || outstanding === null) {
    log?.warn(
      { loanId: loan.id, amount: loan.amount, outstanding: loan.outstanding, total_repayment: loan.total_repayment },
      'loan has a malformed amount column; derived fields omitted'
    )
    return { ...loan, interest_charge: null, repaid_amount: null, repayment_progress_bps: null }
  }
  const repaidAmount = totalRepayment - outstanding
  return {
    ...loan,
    interest_charge: (totalRepayment - amount).toString(),
    repaid_amount: repaidAmount.toString(),
    repayment_progress_bps: repaymentProgressBps(repaidAmount, totalRepayment),
  }
}

// repaid_amount / total_repayment expressed in basis points (0 to 10,000),
// server-side so the frontend doesn't duplicate this math (issue #286).
// BigInt division truncates toward zero, so the multiply-then-divide order
// matters here (`repaid * 10000n / total`, not the reverse) to keep
// sub-basis-point precision from being lost before scaling up. Clamped to
// [0, 10000] since outstanding can (in principle, from an upstream data
// issue) exceed total_repayment or go negative, which would otherwise
// produce a bps value outside the valid range.
function repaymentProgressBps(repaidAmount: bigint, totalRepayment: bigint): number {
  if (totalRepayment <= 0n) return 0
  const bps = (repaidAmount * 10000n) / totalRepayment
  if (bps < 0n) return 0
  if (bps > 10000n) return 10000
  return Number(bps)
}
