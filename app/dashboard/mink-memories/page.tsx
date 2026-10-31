import { MinkMemoryManager } from "./memory-manager";
export default function MinkMemoriesPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Mink memories</h1>
        <p className="mt-2 text-muted-foreground">
          Private to you in this store. Never save passwords or customer
          details.
        </p>
      </header>
      <MinkMemoryManager />
    </main>
  );
}
