async function test() {
  try {
     const inflRes = await fetch("https://www.alphavantage.co/query?function=OVERVIEW&symbol=IBM&apikey=demo");
     const text = await inflRes.text();
     console.log(text.substring(0, 100));
  } catch (e) {
     console.error(e);
  }
}
test();
