import { useState } from 'react';
import { parseWeightInput, weightFieldValue } from '@/utils/helpers';

// v1.18.1 (LimeLog#71): a lift weight field shows and takes the user's unit.
// It used to show and store the raw number, so an lb user's 225 was saved as
// 225 kg (496 lb everywhere else). Storage stays kg. While the field has focus
// it keeps the user's own text: a value with more decimals than the display
// keeps (226.25 lb) would otherwise be rewritten mid-typing by the round trip
// through kg.
//
// v1.18.1 (LimeLog#78): moved out of WorkoutPage so the program editor's
// target weight uses it too; that one was still entered and shown in kg.
export function WeightInput({ weightKg, unit, placeholder, step = '0.5', onChange }: {
  weightKg: number | null | undefined;
  unit: 'kg' | 'lb';
  placeholder?: string;
  step?: string;
  onChange: (weightKg: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number" inputMode="decimal" min="0" step={step}
      value={draft ?? weightFieldValue(weightKg, unit)}
      placeholder={placeholder}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parseWeightInput(e.target.value, unit));
      }}
    />
  );
}
