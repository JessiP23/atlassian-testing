const stages = ["Jira automation", "GitHub Actions", "Pull request review"];

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col justify-center gap-10 py-32 px-16 bg-white dark:bg-black">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
            Pipeline ready
          </h1>
          <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            Jira → GitHub Actions → Pull request
          </p>
        </div>
        <ol className="flex flex-col gap-3">
          {stages.map((stage) => (
            <li
              key={stage}
              className="flex items-center justify-between gap-4 rounded-lg border border-solid border-black/[.08] px-4 py-3 text-base dark:border-white/[.145]"
            >
              <span className="font-medium text-zinc-950 dark:text-zinc-50">
                {stage}
              </span>
              <span className="rounded-full bg-black/[.06] px-2.5 py-0.5 text-sm font-medium text-zinc-600 dark:bg-white/[.08] dark:text-zinc-400">
                Connected
              </span>
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}
