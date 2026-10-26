{{/*
Deployment + ClusterIP Service for one of our Node apps (woo-mcp, shipping-mcp,
everything-mcp, gateway). Every app gets the same hardening: non-root, read-only root
filesystem, all capabilities dropped, probes, requests/limits, no service-account token.

Usage: include "switchyard.app" (dict "root" $ "name" "woo-mcp" "ns" "mcp" "app" .Values.wooMcp)
App values: image.{repository,tag}, port, healthPath / readyPath (empty = tcpSocket probe),
            env (list, rendered through tpl so it can reference .Values), resources.
*/}}
{{- define "switchyard.app" -}}
{{- $r := .root -}}
{{- $a := .app -}}
{{- $c := dict "root" $r "component" .name -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .name }}
  namespace: {{ .ns }}
  labels:
    {{- include "switchyard.labels" $c | nindent 4 }}
spec:
  replicas: {{ $a.replicas | default 1 }}
  selector:
    matchLabels:
      {{- include "switchyard.selectorLabels" $c | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "switchyard.labels" $c | nindent 8 }}
      annotations:
        # Roll the pod when its env (incl. secret names) changes.
        checksum/env: {{ tpl (toYaml $a.env) $r | sha256sum | trunc 16 }}
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: {{ $a.runAsUser | default 1000 }}
        runAsGroup: {{ $a.runAsUser | default 1000 }}
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: {{ .name }}
          image: "{{ $a.image.repository }}:{{ $a.image.tag }}"
          imagePullPolicy: {{ $r.Values.global.imagePullPolicy }}
          ports:
            - name: http
              containerPort: {{ $a.port }}
          env:
            - name: PORT
              value: {{ $a.port | quote }}
            {{- with $a.env }}
            {{- tpl (toYaml .) $r | nindent 12 }}
            {{- end }}
          resources:
            {{- toYaml $a.resources | nindent 12 }}
          readinessProbe:
            {{- if $a.readyPath }}
            httpGet: { path: {{ $a.readyPath }}, port: http }
            {{- else }}
            tcpSocket: { port: http }
            {{- end }}
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            {{- if $a.healthPath }}
            httpGet: { path: {{ $a.healthPath }}, port: http }
            {{- else }}
            tcpSocket: { port: http }
            {{- end }}
            initialDelaySeconds: 10
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 3
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
---
# ClusterIP only: reachable inside the cluster; public access (gateway) goes via Ingress.
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  namespace: {{ .ns }}
  labels:
    {{- include "switchyard.labels" $c | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "switchyard.selectorLabels" $c | nindent 4 }}
  ports:
    - name: http
      port: {{ $a.port }}
      targetPort: http
{{- end -}}

{{/*
A Secret with the same generated values in several namespaces (a pod can only read
Secrets in its own namespace). Values are reused from the first namespace's copy.
Usage: include "switchyard.sharedSecret" (dict "root" $ "name" "x" "namespaces" (list "a" "b") "keys" (dict "token" 48))
A key's value is its random length, or "bytes32" for 32 random bytes base64-encoded.
*/}}
{{- define "switchyard.sharedSecret" -}}
{{- $first := first .namespaces -}}
{{- $existing := lookup "v1" "Secret" $first .name -}}
{{- $data := dict -}}
{{- range $k, $len := .keys -}}
{{- if and $existing (hasKey $existing.data $k) -}}
{{- $_ := set $data $k (index $existing.data $k) -}}
{{- else if eq (toString $len) "bytes32" -}}
{{- /* 32 random bytes, base64 (e.g. an AES-256 key): randBytes already returns base64. */ -}}
{{- $_ := set $data $k (randBytes 32 | b64enc) -}}
{{- else -}}
{{- $_ := set $data $k (randAlphaNum (int $len) | b64enc) -}}
{{- end -}}
{{- end -}}
{{- range $ns := .namespaces }}
---
apiVersion: v1
kind: Secret
metadata:
  name: {{ $.name }}
  namespace: {{ $ns }}
  labels:
    {{- include "switchyard.labels" (dict "root" $.root "component" $.name) | nindent 4 }}
type: Opaque
data:
  {{- toYaml $data | nindent 2 }}
{{- end }}
{{- end -}}
