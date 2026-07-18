(function installMatchSensePushContract(scope) {
  "use strict";

  var identifier = /^[A-Za-z0-9_:-]+$/u;
  var testRun = /^[A-Za-z0-9_-]+$/u;

  function isNonEmptyString(value, maxLength) {
    return (
      typeof value === "string" && value.length > 0 && value.length <= maxLength
    );
  }

  function canonicalIdentity(familyId, revision) {
    return familyId + ":" + revision;
  }

  function canonicalRoute(fixtureId, familyId, revision) {
    return (
      "/matches/" +
      encodeURIComponent(fixtureId) +
      "/moments/" +
      encodeURIComponent(canonicalIdentity(familyId, revision))
    );
  }

  function validRoute(route, fixtureId, familyId, revision) {
    if (
      !isNonEmptyString(route, 500) ||
      route !== canonicalRoute(fixtureId, familyId, revision)
    ) {
      return null;
    }
    return route;
  }

  function testRunFromIdentity(identity, familyId, revision) {
    if (!isNonEmptyString(identity, 360) || !identity.startsWith("test:")) {
      return null;
    }
    var suffix = ":" + familyId + ":" + revision;
    if (!identity.endsWith(suffix)) return null;
    var runId = identity.slice(5, -suffix.length);
    return testRun.test(runId) ? runId : null;
  }

  function parsePayload(value) {
    if (!value || typeof value !== "object") return null;
    var revision = value.revision;
    if (
      value.schemaVersion !== 1 ||
      value.type !== "matchsense.moment" ||
      !isNonEmptyString(value.fixtureId, 80) ||
      !identifier.test(value.fixtureId) ||
      !isNonEmptyString(value.familyId, 240) ||
      !identifier.test(value.familyId) ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      (value.kind !== "moment" && value.kind !== "test") ||
      !isNonEmptyString(value.intentId, 160) ||
      !isNonEmptyString(value.title, 80) ||
      !isNonEmptyString(value.body, 300)
    ) {
      return null;
    }

    var route = validRoute(
      value.route,
      value.fixtureId,
      value.familyId,
      revision,
    );
    if (!route) return null;
    var identity = canonicalIdentity(value.familyId, revision);
    var tag;
    if (value.kind === "moment") {
      if (value.identity !== identity) return null;
      tag = "matchsense:" + value.fixtureId + ":" + value.familyId;
    } else {
      var runId = testRunFromIdentity(value.identity, value.familyId, revision);
      if (!runId) return null;
      tag =
        "matchsense:test:" +
        runId +
        ":" +
        value.fixtureId +
        ":" +
        value.familyId;
    }
    if (value.tag !== tag) return null;

    return {
      body: value.body,
      deliveryIdentity: value.identity,
      familyId: value.familyId,
      fixtureId: value.fixtureId,
      intentId: value.intentId,
      kind: value.kind,
      occurredAt:
        typeof value.occurredAt === "string" ? value.occurredAt : null,
      momentIdentity: identity,
      revision: revision,
      route: route,
      tag: tag,
      title: value.title,
    };
  }

  function parseRouteData(value) {
    if (!value || typeof value !== "object") return null;
    var revision = value.revision;
    if (
      !isNonEmptyString(value.fixtureId, 80) ||
      !identifier.test(value.fixtureId) ||
      !isNonEmptyString(value.familyId, 240) ||
      !identifier.test(value.familyId) ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      (value.kind !== "moment" && value.kind !== "test") ||
      !isNonEmptyString(value.intentId, 160)
    ) {
      return null;
    }
    var route = validRoute(
      value.route || value.url,
      value.fixtureId,
      value.familyId,
      revision,
    );
    if (!route) return null;
    return {
      familyId: value.familyId,
      fixtureId: value.fixtureId,
      intentId: value.intentId,
      kind: value.kind,
      momentIdentity: canonicalIdentity(value.familyId, revision),
      revision: revision,
      url: route,
    };
  }

  function notificationFor(value) {
    var payload = parsePayload(value);
    if (!payload) {
      return {
        options: {
          body: "Open MatchSense for the latest verified match update.",
          data: { url: "/" },
          icon: "/icons/matchsense-icon.svg",
          tag: "matchsense:update",
        },
        title: "MatchSense update",
      };
    }
    var timestamp = Date.parse(payload.occurredAt || "");
    return {
      options: {
        body: payload.body,
        data: {
          deliveryIdentity: payload.deliveryIdentity,
          familyId: payload.familyId,
          fixtureId: payload.fixtureId,
          identity: payload.momentIdentity,
          intentId: payload.intentId,
          kind: payload.kind,
          momentIdentity: payload.momentIdentity,
          revision: payload.revision,
          route: payload.route,
          url: payload.route,
        },
        icon: "/icons/matchsense-icon.svg",
        renotify: true,
        tag: payload.tag,
        ...(Number.isFinite(timestamp) ? { timestamp: timestamp } : {}),
      },
      title: payload.title,
    };
  }

  function routeFromNotificationData(value) {
    return parseRouteData(value) || { url: "/" };
  }

  scope.MatchSensePush = Object.freeze({
    notificationFor: notificationFor,
    routeFromNotificationData: routeFromNotificationData,
  });
})(self);
