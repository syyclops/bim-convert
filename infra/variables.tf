variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "vm_size" {
  description = "VM size"
  type        = string
  default     = "Standard_D2s_v3"
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
  description = "Prefix for all resource names"
  type        = string
  default     = "bimconvert"
}

variable "allowed_ip" {
  description = "IP address allowed for RDP access (use * for any)"
  type        = string
  default     = "*"
}
