variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "api_vm_size" {
  description = "VM size for the API server"
  type        = string
  default     = "Standard_B2s"
}

variable "worker_vm_size" {
  description = "VM size for the conversion worker (needs enough RAM for large .rvt files)"
  type        = string
  default     = "Standard_D4s_v3"
}

variable "admin_username" {
  description = "VM admin username"
  type        = string
  default     = "adminuser"
}

variable "admin_password" {
  description = "VM admin password"
  type        = string
  sensitive   = true
}

variable "resource_prefix" {
  description = "Prefix for all resource names (max 11 chars for Windows hostname limit)"
  type        = string
  default     = "bimconvert"

  validation {
    condition     = length(var.resource_prefix) <= 11
    error_message = "resource_prefix must be 11 characters or fewer (Windows hostname limit)."
  }
}

variable "allowed_ip" {
  description = "IP address allowed for SSH/RDP access (use * for any)"
  type        = string
  default     = "*"
}

variable "domain" {
  description = "Domain name for HTTPS (e.g. convert.example.com). Set your DNS A record to point to the API VM IP."
  type        = string
}

variable "worker_idle_timeout_minutes" {
  description = "Minutes of idle time before worker auto-deallocates"
  type        = number
  default     = 15
}
