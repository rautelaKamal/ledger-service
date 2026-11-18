import { PERSONAS, type Persona } from '@/lib/personas';

/** Switch person with a plain form: works without JavaScript, keeps the client id on the server. */
export function PersonaSwitcher({ current }: { current: Persona }) {
  return (
    <form action="/api/session" method="post" className="flex flex-col gap-1.5">
      <label htmlFor="persona" className="text-sm text-ink-soft">
        You are
      </label>
      <div className="flex gap-2">
        <select
          id="persona"
          name="persona"
          defaultValue={current.key}
          className="min-w-0 flex-1 rounded-md border border-input bg-surface px-2 py-1.5"
        >
          {PERSONAS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-md border border-input px-2.5 text-sm hover:border-ink">
          Switch
        </button>
      </div>
    </form>
  );
}
