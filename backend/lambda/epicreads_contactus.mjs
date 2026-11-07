import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

// Environment configurations
const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE_NAME = process.env.TABLE_NAME || "ContactMessages";
const RECEIVER = "test1@gmail.com";
const SENDER = "test2@gmail.com";

// Clients initialization
const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Main Lambda Handler Entry Point
 */

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event));

  // 1. Try to find an explicit HTTP method from API Gateway wrappers
  let method = (
    event?.httpMethod || 
    event?.requestContext?.http?.method || 
    event?.requestContext?.httpMethod || 
    event?.method || 
    ""
  ).toUpperCase();

  // 2. Dynamic Fallback: If no method properties exist but fields like 'name' or 'email' are passed directly
  if (!method && (event?.name || event?.email || typeof event?.body === "string")) {
    console.log("No API Gateway wrapper detected. Defaulting to POST context for local/direct test execution.");
    method = "POST";
  }

  console.log("Final Decided HTTP Method:", method);

  // 3. Keep the rest of your routing code exactly as it is...
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders("OPTIONS,GET,POST"), body: "" };
  }
  if (method === "GET") {
    return await handleGet(event);
  } else if (method === "POST") {
    return await handlePost(event);
  } else {
    return {
      statusCode: 405,
      headers: corsHeaders("OPTIONS,GET,POST"),
      body: JSON.stringify({ error: `Method '${method}' Not Allowed` })
    };
  }
};

/**
 * GET Controller - Fetches and paginates contact messages from DynamoDB
 */
async function handleGet(event) {
  try {
    const qs = event?.queryStringParameters || {};
    const limit = Math.min(parseInt(qs.limit || "25", 10), 100);
 
    const scanInput = {
      TableName: TABLE_NAME,
      Limit: limit,
      ProjectionExpression: "#id, #n, email, phone, message, createdAt",
      ExpressionAttributeNames: { "#id": "id", "#n": "name" }
    };
 
    // Pagination support
    if (qs.lastKey) {
      scanInput.ExclusiveStartKey = JSON.parse(
        Buffer.from(qs.lastKey, "base64").toString("utf8")
      );
    }
 
    const res = await ddb.send(new ScanCommand(scanInput));
 
    // Sort items by descending createdAt timestamp
    const items = (res.Items || []).sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
 
    const body = {
      items,
      lastKey: res.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64")
        : null
    };
 
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders("OPTIONS,GET,POST"),
        "Cache-Control": "no-store"
      },
      body: JSON.stringify(body)
    };
  } catch (e) {
    console.error("GET Execution Error:", e);
    return {
      statusCode: 500,
      headers: corsHeaders("OPTIONS,GET,POST"),
      body: JSON.stringify({ error: "Internal server error reading messages" })
    };
  }
}

/**
 * POST Controller - Saves form to DynamoDB and fires email notifications via SES
 */
async function handlePost(event) {
  try {
    // Parse incoming JSON body regardless of stringified encapsulation state
    const body =
      typeof event?.body === "string" ? JSON.parse(event.body) :
      (event?.body ?? event ?? {});

    const { name = "", phone = "", email = "", message = "" } = body;

    // Validation
    if (!name || !email) {
      return {
        statusCode: 400,
        headers: corsHeaders("OPTIONS,GET,POST"),
        body: JSON.stringify({ error: "name and email are required fields" })
      };
    }

    const id = randomUUID();
    const ts = new Date().toISOString();

    // 1) Save to DynamoDB Table
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { id, name, phone, email, message, createdAt: ts }
    }));

    // 2) Structure Email Delivery Parameters via SES
    const params = {
      Destination: { ToAddresses: [RECEIVER] },
      Message: {
        Subject: { Data: `Website Query Form: ${name}`, Charset: "UTF-8" },
        Body: {
          Text: {
            Data: `Full Name: ${name}\nPhone: ${phone}\nEmail: ${email}\nMessage: ${message}\nID: ${id}\nTime: ${ts}`,
            Charset: "UTF-8"
          }
        }
      },
      Source: SENDER
    };

    // Inject ReplyTo only if provided string patterns conform to email rules
    if (EMAIL_RE.test(email)) {
      params.ReplyToAddresses = [email];
    }

    await ses.send(new SendEmailCommand(params));

    return {
      statusCode: 200,
      headers: corsHeaders("OPTIONS,GET,POST"),
      body: JSON.stringify({ ok: true, id })
    };
  } catch (err) {
    console.error("POST Execution Error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders("OPTIONS,GET,POST"),
      body: JSON.stringify({ error: "Internal server error creating message" })
    };
  }
}

/**
 * Universal CORS Header Generator Helper
 */
function corsHeaders(methods = "OPTIONS,GET,POST") {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Api-Key,X-Amz-Date,X-Amz-Security-Token"
  };
}