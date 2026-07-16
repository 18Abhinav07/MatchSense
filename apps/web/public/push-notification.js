(function installMatchSensePushContract(scope) {
  "use strict";

  function isNonEmptyString(value, maxLength) {
    return (
      typeof value === "string" && value.length > 0 && value.length <= maxLength
    );
  }

  function parseMoment(value) {
    if (!value || typeof value !== "object") return null;
    const revision = value.revision;
    if (
      value.schemaVersion !== 1 ||
      value.type !== "matchsense.moment" ||
      !isNonEmptyString(value.fixtureId, 80) ||
      !/^[A-Za-z0-9_-]+$/u.test(value.fixtureId) ||
      !isNonEmptyString(value.momentId, 240) ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      value.identity !== `${value.momentId}:${revision}` ||
      !isNonEmptyString(value.title, 80) ||
      !isNonEmptyString(value.body, 300)
    ) {
      return null;
    }
    return {
      body: value.body,
      fixtureId: value.fixtureId,
      identity: value.identity,
      momentId: value.momentId,
      occurredAt:
        typeof value.occurredAt === "string" ? value.occurredAt : null,
      revision,
      title: value.title,
    };
  }

  function deepLink(moment) {
    return `/matches/${encodeURIComponent(moment.fixtureId)}/moments/${encodeURIComponent(moment.identity)}`;
  }

  function notificationFor(value) {
    const moment = parseMoment(value);
    if (!moment) {
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
    const timestamp = Date.parse(moment.occurredAt || "");
    return {
      options: {
        body: moment.body,
        data: {
          fixtureId: moment.fixtureId,
          identity: moment.identity,
          momentId: moment.momentId,
          momentIdentity: moment.identity,
          revision: moment.revision,
          url: deepLink(moment),
        },
        icon: "/icons/matchsense-icon.svg",
        renotify: true,
        tag: `matchsense:${moment.identity}`,
        ...(Number.isFinite(timestamp) ? { timestamp } : {}),
      },
      title: moment.title,
    };
  }

  function routeFromNotificationData(value) {
    if (!value || typeof value !== "object") return { url: "/" };
    const moment = parseMoment({
      body: "notification route",
      fixtureId: value.fixtureId,
      identity: value.identity,
      momentId: value.momentId,
      revision: value.revision,
      schemaVersion: 1,
      title: "notification route",
      type: "matchsense.moment",
    });
    if (!moment) return { url: "/" };
    return {
      fixtureId: moment.fixtureId,
      momentId: moment.momentId,
      momentIdentity: moment.identity,
      revision: moment.revision,
      url: deepLink(moment),
    };
  }

  scope.MatchSensePush = Object.freeze({
    notificationFor,
    routeFromNotificationData,
  });
})(self);
