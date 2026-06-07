'use client';

type SeasonRepairTabProps = {
  running: boolean;
  status: string | null;
  onImport: (file: File | null) => void;
};

export default function SeasonRepairTab({ running, status, onImport }: SeasonRepairTabProps) {
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-950">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined mt-0.5 text-[22px] text-red-700">warning</span>
          <div className="min-w-0">
            <h2 className="font-h3 text-[18px] font-semibold">Seasonal Full Replace</h2>
            <p className="mt-1 max-w-3xl text-sm text-red-900">
              Rebuild an entire seasonal baseline from an import file. This is a repair action for correcting a full season,
              not the normal partial Seasonal import workflow.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-on-surface">Replace full season from file</h3>
            <p className="mt-1 text-sm text-on-surface-variant">
              Existing baseline records, modifications, and history for the season code in the file will be cleared and recreated.
            </p>
          </div>
          <label
            className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              running
                ? 'pointer-events-none bg-surface-container-high text-on-surface-variant opacity-60'
                : 'bg-red-700 text-white hover:bg-red-800'
            }`}
          >
            <span className={`material-symbols-outlined text-[18px] ${running ? 'animate-spin' : ''}`}>
              {running ? 'progress_activity' : 'upload_file'}
            </span>
            {running ? 'Replacing' : 'Choose file'}
            <input
              type="file"
              accept=".xlsx,.xls,.xlsm"
              disabled={running}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = '';
                onImport(file);
              }}
            />
          </label>
        </div>
        {status && <p className="mt-3 text-sm text-on-surface-variant">{status}</p>}
      </div>
    </section>
  );
}
