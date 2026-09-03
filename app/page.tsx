const stages = [
  "Jira automation",
  "GitHub Actions",
  "Pull request review",
];

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-center gap-6 py-32 px-16 bg-white dark:bg-black sm:items-start">
        <h1 className="text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
          Pipeline ready
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Jira → GitHub Actions → Pull request
        </p>
        <ol className="flex w-full flex-col gap-3">
          {stages.map((stage) => (
            <li
              key={stage}
              className="flex items-center justify-between gap-4 rounded-lg border border-solid border-black/[.08] px-4 py-3 text-base font-medium text-black dark:border-white/[.145] dark:text-zinc-50"
            >
              {stage}
              <span className="rounded-full bg-black/[.06] px-3 py-1 text-sm font-medium text-zinc-600 dark:bg-white/[.08] dark:text-zinc-400">
                Connected
              </span>
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}
