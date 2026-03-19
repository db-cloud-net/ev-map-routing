import Link from "next/link";

export default function HomePage() {
  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>EV Travel Planner</h1>
      <p>
        <Link href="/map">Open planner</Link>
      </p>
    </div>
  );
}

