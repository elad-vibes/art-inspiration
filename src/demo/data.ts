// In the demo build this file REPLACES src/data.ts (vite.config.ts, mode "demo"). The real one
// remembers the chosen studio and the user's name in the browser and in the database; the demo
// has no menu and stores nothing, so both are empty.
export async function chooseStudio(_id: string): Promise<void> {}
export async function saveMyName(_name: string): Promise<void> {}
