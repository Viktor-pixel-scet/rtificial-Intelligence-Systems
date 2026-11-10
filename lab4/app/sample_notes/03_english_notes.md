# HTTP basics

HTTP is a request–response protocol: a client sends a request and the server returns a response. A request has a method, a URL, headers and an optional body. The most common methods are GET, which reads a resource, and POST, which sends data to the server.

## Status codes

Status codes are grouped by their first digit. Codes starting with 2 mean success, with 3 mean redirection, with 4 mean a client error such as 404 Not Found, and with 5 mean a server error such as 500 Internal Server Error.

## Idempotency

A method is idempotent if repeating the same request leaves the server in the same state. GET, PUT and DELETE are idempotent, while POST usually is not, which is why submitting a payment form twice can create two payments.

## Statelessness

HTTP itself is stateless: the server does not remember previous requests. Applications add state with cookies or tokens that the client sends with every request.
