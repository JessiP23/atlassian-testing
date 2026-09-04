"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

type Asset = {
  tag: string;
  name: string;
  location: string;
};

export default function Home() {
  const [query, setQuery] = useState("");
  const [searchedFor, setSearchedFor] = useState("");
  const [results, setResults] = useState<Asset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // KAN-11: the searched term is held apart from the input value so Retry replays the query that
  // failed, whatever the user has typed since.
  async function runSearch(term: string) {
    setSearchedFor(term);
    setLoading(true);
    setFailed(false);
    setResults(null);

    try {
      const response = await fetch(
        `/api/assets/search?q=${encodeURIComponent(term)}`,
      );
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const body: { results?: Asset[] } = await response.json();
      setResults(body.results ?? []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(query);
  }

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <section className="w-full max-w-3xl bg-white px-16 pt-16 dark:bg-black">
        <h2 className="text-xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Asset lookup
        </h2>
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={handleSubmit}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <label
              htmlFor="asset-search"
              className="text-sm font-medium text-zinc-600 dark:text-zinc-400"
            >
              Search assets
            </label>
            <input
              id="asset-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tag, name or location"
              className="h-11 rounded-lg border border-solid border-black/[.08] px-3 text-base text-black placeholder:text-zinc-400 dark:border-white/[.145] dark:text-zinc-50"
            />
          </div>
          <button
            type="submit"
            className="h-11 rounded-full bg-foreground px-5 text-base font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            Search
          </button>
        </form>

        <div aria-live="polite" className="mt-4 min-h-6 text-base">
          {loading && (
            <p className="text-zinc-600 dark:text-zinc-400">Searching…</p>
          )}
          {!loading && failed && (
            <div className="flex flex-col items-start gap-2">
              <p className="text-red-600 dark:text-red-400">
                Something went wrong while looking up assets.
              </p>
              <button
                type="button"
                onClick={() => void runSearch(searchedFor)}
                className="h-9 rounded-full border border-solid border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a]"
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !failed && results?.length === 0 && (
            <p className="text-zinc-600 dark:text-zinc-400">
              No matching assets found.
            </p>
          )}
          {!loading && !failed && results && results.length > 0 && (
            <ul className="flex flex-col gap-2">
              {results.map((asset) => (
                <li
                  key={asset.tag}
                  className="rounded-lg border border-solid border-black/[.08] px-3 py-2 dark:border-white/[.145]"
                >
                  <span className="font-mono text-sm text-black dark:text-zinc-50">
                    {asset.tag}
                  </span>
                  <span className="ml-2 text-black dark:text-zinc-50">
                    {asset.name}
                  </span>
                  <span className="block text-sm text-zinc-600 dark:text-zinc-400">
                    {asset.location}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-black sm:items-start">
        <Image
          className="dark:invert h-5 w-[100px]"
          src="/next.svg"
          alt="Next.js logo"
          width={100}
          height={20}
          priority
        />
        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
          <h1 className="max-w-xs text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
            To get started, edit the{" "}
            <code className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-white/[.08]">
              page.tsx
            </code>{" "}
            file.
          </h1>
          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            Looking for a starting point or more instructions? Head over to{" "}
            <a
              href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
              className="font-medium text-zinc-950 dark:text-zinc-50"
            >
              Templates
            </a>{" "}
            or the{" "}
            <a
              href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
              className="font-medium text-zinc-950 dark:text-zinc-50"
            >
              Learning
            </a>{" "}
            center.
          </p>
        </div>
        <div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
          <a
            className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] md:w-[158px]"
            href="https://vercel.com/new?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Image
              className="dark:invert h-[14px] w-4"
              src="/vercel.svg"
              alt="Vercel logomark"
              width={16}
              height={14}
            />
            Deploy Now
          </a>
          <a
            className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] md:w-[158px]"
            href="https://nextjs.org/docs?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            Documentation
          </a>
        </div>
      </main>
    </div>
  );
}
