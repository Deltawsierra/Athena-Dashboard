/**
 * An amount of money, as Athena-Backend served it, and nothing else.
 *
 * The served decimal string is shown exactly, beside the served currency code:
 * no sum, no conversion, no rounding, and never a float (lib/economics.ts
 * servedAmount). Every amount on the economics views goes through here, so
 * every one carries `data-money` and the string it shows (`data-amount`), which
 * the tests hold to the served documents.
 *
 * `minorUnit` is the currency's minor unit the document states (JPY 0, KWD 3):
 * a loss figure the backend states at it. A figure whose places differ is still
 * shown exactly as served, and marked -- this never pads or rounds it. A
 * parameter's own figures are as recorded (a unit cost may lie below the minor
 * unit), so they are shown without that check.
 */
import { placesOf, servedAmount } from "@/lib/economics";

interface MoneyProps {
  value: unknown;
  currency: string;
  /** The minor unit this figure is stated at, where the document states loss at it. */
  minorUnit?: number | null;
  /** Why a figure is not reported, where the document says. */
  reason?: string | null;
}

export default function Money({ value, currency, minorUnit, reason }: MoneyProps) {
  const amount = servedAmount(value);
  if (amount.kind === "absent") {
    return (
      <span className="text-muted-foreground" data-not-reported="">
        not reported{reason ? `: ${reason}` : ""}
      </span>
    );
  }
  if (amount.kind === "unreadable") {
    return (
      <span className="text-sev-high" data-unreadable-amount="">
        unreadable amount ({amount.why}): not shown
      </span>
    );
  }
  const off = typeof minorUnit === "number" && placesOf(amount.text) !== minorUnit;
  return (
    <span className="font-mono tabular-nums" data-money="" data-amount={amount.text} data-currency={currency}>
      {currency} {amount.text}
      {off && (
        <span className="ml-1 text-[10px] text-sev-high" data-minor-unit-mismatch="">
          (served at {placesOf(amount.text)} places, not {currency}&apos;s {minorUnit})
        </span>
      )}
    </span>
  );
}
