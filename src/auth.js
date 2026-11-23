// Who's asking, on one server's page. The Worker (src/index.js) checks the cookies before a request reaches
// the server: the viewer cookie from joining with the server's password, and the sign-in cookie from an
// email code (src/session.js). The server's Tenant object then decides what they amount to there
// (src/tenant.js, access()) and puts it on env.WHO:
//   { email }        signed in, and a member of this server (roles: src/roles.js)
//   { email: null }  can look (joined with the password, or the server is public), nothing more
// No env.WHO means not let in at all: the API answers 401 and the page goes to /join.
export async function signedIn(request, env) {
  return env.WHO ?? null;
}
