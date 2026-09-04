"use client";

import Image from "next/image";
import { useLayoutEffect } from "react";

type Theme = "dark" | "light";

/** The choice the visitor made on an earlier visit, or null if they have not made one. */
function storedTheme(): Theme | null {
  try {
    const theme = window.localStorage.getItem("theme");
    return theme === "dark" || theme === "light" ? theme : null;
  } catch {
    return null;
  }
}

function preferredTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The class on <html> is what the CSS reads; localStorage.theme is only the record of it. */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

function ThemeToggle() {
  // The inline script in the root layout already set the class while parsing. React's dev-only
  // remount resets <html> to the classes it manages from JSX, dropping it, so re-apply it before
  // paint. A no-op in production.
  useLayoutEffect(() => {
    applyTheme(storedTheme() ?? preferredTheme());
  }, []);

  function toggle() {
    const next: Theme = document.documentElement.classList.contains("dark")
      ? "light"
      : "dark";
    try {
      window.localStorage.setItem("theme", next);
    } catch {
      // A visitor with storage blocked still gets the toggle, just not the memory of it.
    }
    applyTheme(next);
  }

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={toggle}
      className="fixed right-6 top-6 flex h-10 w-10 items-center justify-center rounded-full border border-solid border-black/[.08] text-zinc-600 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-400 dark:hover:bg-[#1a1a1a]"
    >
      <svg
        className="h-5 w-5 dark:hidden"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4.25" />
        <path d="M12 2.5v2.25M12 19.25v2.25M2.5 12h2.25M19.25 12h2.25M5.28 5.28l1.6 1.6M17.12 17.12l1.6 1.6M18.72 5.28l-1.6 1.6M6.88 17.12l-1.6 1.6" />
      </svg>
      <svg
        className="hidden h-5 w-5 dark:block"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20.5 14.4A8.75 8.75 0 0 1 9.6 3.5a8.75 8.75 0 1 0 10.9 10.9Z" />
      </svg>
    </button>
  );
}

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <ThemeToggle />
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
