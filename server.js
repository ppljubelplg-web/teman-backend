const express = require("express");
const backend = require("./index");

const app = express();

app.get("/", (req, res) => {
  res.json({ service: "TEMAN backend", status: "online" });
});

app.all("/temanHealth", backend.temanHealth);
app.all("/temanApi", backend.temanApi);

const port = process.env.PORT || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(`TEMAN backend berjalan pada port ${port}`);
});
