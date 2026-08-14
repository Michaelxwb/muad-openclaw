{{/*
Expand the name of the chart.
*/}}
{{- define "muad-console.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "muad-console.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "muad-console.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "muad-console.labels" -}}
helm.sh/chart: {{ include "muad-console.chart" . }}
{{ include "muad-console.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "muad-console.selectorLabels" -}}
app.kubernetes.io/name: {{ include "muad-console.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "muad-console.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "muad-console.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Render worker nodeSelector values for the Console backend env parser.
*/}}
{{- define "muad-console.workerNodeSelectorEnv" -}}
{{- $pairs := list -}}
{{- range $key := keys . | sortAlpha -}}
{{- $pairs = append $pairs (printf "%s=%v" $key (index $ $key)) -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end }}
