import express from "express";

const app = express();
app.use(express.json());

let remaining = 1;
let reservationId: string | null = null;

app.get("/event", (_request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AUTOBOT Classroom Test Drop</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0c0d10; color: #f7f3ea; }
      main { width: min(680px, calc(100% - 40px)); }
      .eyebrow { color: #b8ff5a; text-transform: uppercase; letter-spacing: .16em; font-weight: 700; }
      h1 { font-size: clamp(2.4rem, 7vw, 5.4rem); line-height: .93; margin: 20px 0; }
      .card { margin-top: 38px; padding: 24px; border: 1px solid #34373e; border-radius: 18px; background: #15171b; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
      button { border: 0; border-radius: 999px; padding: 14px 20px; background: #b8ff5a; color: #10120d; font: inherit; font-weight: 800; cursor: pointer; }
      button:disabled { background: #555; cursor: not-allowed; }
      #status { min-height: 24px; margin-top: 18px; color: #b8ff5a; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Controlled classroom environment</p>
      <h1>AUTOBOT Classroom Test Drop</h1>
      <p>One free RSVP. One atomic reservation. No payments or real attendee data.</p>
      <section class="card">
        <div class="row">
          <div>
            <strong data-testid="ticket-name">Free Test RSVP</strong>
            <p id="inventory">${remaining} remaining · Free</p>
          </div>
          <button id="reserve" ${remaining === 0 ? "disabled" : ""}>Reserve free ticket</button>
        </div>
        <div id="status" role="status"></div>
      </section>
    </main>
    <script>
      const button = document.querySelector("#reserve");
      button.addEventListener("click", async () => {
        button.disabled = true;
        const result = await fetch("/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const payload = await result.json();
        document.querySelector("#status").textContent = result.ok ? "Reservation confirmed" : payload.error;
        if (!result.ok) button.disabled = false;
      });
    </script>
  </body>
</html>`);
});

app.post("/api/reservations", (_request, response) => {
  if (remaining === 0) {
    response.status(409).json({ error: "Sold out" });
    return;
  }

  remaining = 0;
  reservationId = crypto.randomUUID();
  response.status(201).json({ reservationId });
});

app.post("/api/reset", (_request, response) => {
  remaining = 1;
  reservationId = null;
  response.status(204).end();
});

app.get("/api/state", (_request, response) => {
  response.json({ remaining, reservationId });
});

app.listen(4173, "127.0.0.1", () => {
  console.log("Mock event ready at http://127.0.0.1:4173/event");
});
