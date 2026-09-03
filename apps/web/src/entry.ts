import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Runtime from "foldkit/runtime"

import { Flags, Message, Model, flags, init, subscriptions, update, view } from "./main"

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
  resources: Layer.mergeAll(BrowserKeyValueStore.layerLocalStorage, FetchHttpClient.layer),
  devTools: {
    Message,
  },
})

Runtime.run(application, { flags })
