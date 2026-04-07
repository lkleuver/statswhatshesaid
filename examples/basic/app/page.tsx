export default function Home() {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 40 }}>
      <h1>statswhatshesaid example</h1>
      <p>
        Visit <a href="/stats?t=testsecret">/stats?t=testsecret</a> to see the JSON
        response.
      </p>
    </main>
  )
}
